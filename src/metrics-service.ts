import * as metrics from 'prom-client';
import {Collection, identity, option} from 'scats';
import {Registry} from 'prom-client';

export type GaugeValueCollector = () => any;
export type Labels = Readonly<Record<string, string>>;

export namespace MetricsService {

    const registry = new metrics.Registry();
    const labels = new Map<string, string>();
    const gauges = new Map<string, {name: string; labels: Labels; collect: GaugeValueCollector}>();
    const metricNames = new Map<string, string>();

    const getMetric = <M extends metrics.Counter<string> | metrics.Gauge<string> | metrics.Summary<string>>(
        name: string, labels: Labels, create: (name: string, labelNames: string[]) => M,
    ): M => {
        const labelNames = Object.keys(labels).sort();
        const key = JSON.stringify([name, labelNames]);
        const cachedName = metricNames.get(key);
        if (cachedName) {
            const existing = registry.getSingleMetric(cachedName);
            if (existing) return existing as M;
        }
        let metricName = name;
        let suffix = 1;
        while (registry.getSingleMetric(metricName)) {
            metricName = `${name}_${suffix++}`;
        }
        const metric = create(metricName, labelNames);
        metricNames.set(key, metricName);
        return metric;
    };

    const seriesName = (name: string, labels: Labels): string => {
        const names = Object.keys(labels).sort();
        return names.length ? `${name}{${names.map(key => `${key}=${JSON.stringify(labels[key])}`).join(',')}}` : name;
    };

    let metricsPrefix = '';

    export function getInternalRegistry(): Registry {
        return registry;
    }

    export function setProjectName(projectName: string): void {
        metricsPrefix = `${projectName}_`;
    }

    /**
     * Set static labels to every metric emitted by this registry
     * @param labels of name/value pairs:
     * { defaultLabel: "value", anotherLabel: "value 2" }
     */
    export function setStaticLabels(labels: Record<string, string>): void {
        registry.setDefaultLabels(labels);
    }

    export function clear(): void {
        labels.clear();
        gauges.clear();
        metricNames.clear();
        registry.clear();
        metricsPrefix = '';
    }


    export function counter(name: string, labels?: undefined): metrics.Counter<string>;
    export function counter(name: string, labels: Labels): metrics.Counter.Internal;
    export function counter(name: string, labels?: Labels): metrics.Counter<string> | metrics.Counter.Internal;
    export function counter(name: string, labels?: Labels): metrics.Counter<string> | metrics.Counter.Internal {
        const metric = getMetric(`counter_${metricsPrefix}${name}`, labels ?? {}, (name, labelNames) =>
            new metrics.Counter({name, help: name, labelNames, registers: [registry]}));
        return labels === undefined ? metric : metric.labels(...Object.keys(labels).sort().map(name => labels[name]));
    }

    export function histogram(name: string, labels?: undefined): metrics.Summary<string>;
    export function histogram(name: string, labels: Labels): metrics.Summary.Internal<string>;
    export function histogram(name: string, labels?: Labels): metrics.Summary<string> | metrics.Summary.Internal<string>;
    export function histogram(name: string, labels?: Labels): metrics.Summary<string> | metrics.Summary.Internal<string> {
        const metric = getMetric(`histogram_${metricsPrefix}${name}`, labels ?? {}, (name, labelNames) =>
            new metrics.Summary({name, help: name, labelNames, registers: [registry]}));
        return labels === undefined ? metric : metric.labels(...Object.keys(labels).sort().map(name => labels[name]));
    }

    export function label(name: string, value: string): void {
        labels.set(name, value);
    }


    export async function toPrometheus(): Promise<string> {
        flushGauges();
        const res = await registry.metrics();
        return new Collection(res.split('\n'))
            .map(line => {
                if (line.startsWith('timer_')) {
                    return line.substring('timer_'.length);
                } else if (line.startsWith('counter_')) {
                    return line.substring('counter_'.length);
                } else if (line.startsWith('histogram_')) {
                    return line.substring('histogram_'.length);
                } else if (line.startsWith('gauge_')) {
                    return line.substring('gauge_'.length);
                } else {
                    return line;
                }
            })
            .mkString('\n');
    }

    export function flushGauges(): void {
        gauges.forEach(({name, labels, collect}) => {
            const value = collect();
            if (!isNaN(value)) {
                const metric = getMetric(`gauge_${name}`, labels, (name, labelNames) =>
                    new metrics.Gauge({name, help: name, labelNames, registers: [registry]}));
                metric.set(labels, value);
            }
        });
    }

    export async function toJson(): Promise<MetricsJson> {
        const res: MetricsJson = {
            counters: {},
            labels: {},
            gauges: {},
            timers: {},
            histograms: {},
            unknown: {},
        };

        labels.forEach((value, key) => {
            res.labels[key] = value;
        });

        flushGauges();
        gauges.forEach(({collect}, key) => {
            const value = collect();
            if (isNaN(value)) res.gauges[key] = value;
        });

        const arrayOfMetrics = Collection.from(await registry.getMetricsAsArray())
            .sort((a, b) => a.name.localeCompare(b.name));
        for (const metric of arrayOfMetrics) {
            if (metric.name.startsWith('counter_') || metric.name.startsWith('gauge_')) {
                const values = await (registry.getSingleMetric(metric.name) as metrics.Counter<string> | metrics.Gauge<string>).get();
                const target = metric.name.startsWith('counter_') ? res.counters : res.gauges;
                const name = metric.name.replace(/^(counter_|gauge_)/, '');
                for (const sample of values.values) {
                    target[seriesName(name, sample.labels as Labels)] = sample.value;
                }
            } else if (metric.name.startsWith('timer_') || metric.name.startsWith('histogram_')) {
                const values = await (registry.getSingleMetric(metric.name) as metrics.Summary<string>).get();
                const target = metric.name.startsWith('timer_') ? res.timers : res.histograms;
                const name = metric.name.replace(/^(timer_|histogram_)/, '');
                for (const sample of values.values) {
                    const {quantile, ...labels} = sample.labels;
                    const key = seriesName(name, labels as Labels);
                    if (!target[key]) target[key] = {} as TimerJson;
                    if (sample.metricName === `${metric.name}_count`) {
                        target[key].count = sample.value;
                    } else if (quantile !== undefined && [0.5, 0.9, 0.95, 0.99].includes(Number(quantile))) {
                        target[key][String(Number(quantile) * 100) as '50' | '90' | '95' | '99'] = sample.value;
                    }
                }
            } else {
                res.unknown[metric.name] = await registry.getSingleMetricAsString(metric.name);
            }
        }

        return res;
    }


    export async function toConsole(): Promise<string> {
        const metrics = await MetricsService.toJson();
        let msg = '****** METRICS ******\n';

        const len = new Collection(Object.keys(metrics.timers))
            .appendedAll(new Collection<string>(Object.keys(metrics.labels)))
            .appendedAll(new Collection<string>(Object.keys(metrics.counters)))
            .appendedAll(new Collection<string>(Object.keys(metrics.timers)))
            .appendedAll(new Collection<string>(Object.keys(metrics.histograms)))
            .appendedAll(new Collection<string>(Object.keys(metrics.gauges)))
            .map(_ => _.length)
            .maxByOption(identity)
            .getOrElseValue(0) + 3;


        if (Object.keys(metrics.labels).length > 0) {
            msg += 'Labels:'.padEnd(len) + '\n';
            for (const name in metrics.labels) {
                msg += `  ${(name + ':').padEnd(len)}${JSON.stringify(metrics.labels[name])}\n`;
            }
        }

        if (Object.keys(metrics.counters).length > 0) {
            msg += 'Counters:'.padEnd(len) + '\n';
            for (const name in metrics.counters) {
                msg += `  ${(name + ':').padEnd(len)}${(metrics.counters[name] as number).toLocaleString().padStart(12)}\n`;
            }
        }

        if (Object.keys(metrics.gauges).length > 0) {
            msg += 'Gauges:'.padEnd(len) + '\n';
            for (const name in metrics.gauges) {
                const gaugeValue = metrics.gauges[name];
                if (isNaN(gaugeValue)) {
                    msg += `  ${(name + ':').padEnd(len)}${gaugeValue}\n`;
                } else {
                    msg += `  ${(name + ':').padEnd(len)}${(gaugeValue as number).toLocaleString().padStart(12)}\n`;
                }
            }
        }

        if (Object.keys(metrics.timers).length > 0) {
            msg += 'Timers:'.padEnd(len) + '\n';
            for (const name in metrics.timers) {
                msg += `  ${(name + ':').padEnd(len)}${JSON.stringify(metrics.timers[name])}\n`;
            }
        }

        if (Object.keys(metrics.histograms).length > 0) {
            msg += 'Histograms:'.padEnd(len) + '\n';
            for (const name in metrics.histograms) {
                msg += `  ${(name + ':').padEnd(len)}${JSON.stringify(metrics.histograms[name])}\n`;
            }
        }

        return msg.trimEnd();
    }

    export function gauge(name: string, value: GaugeValueCollector, labels: Labels = {}): void {
        const gaugeMetricName = `${metricsPrefix}${name}`;
        const key = seriesName(gaugeMetricName, labels);
        if (!gauges.has(key)) {
            gauges.set(key, {name: gaugeMetricName, labels: {...labels}, collect: value});
        }
    }

    export function timer(name: string, conf?: TimerConfiguration, labels: Labels = {}): Timer {
        const metric = getMetric(`timer_${metricsPrefix}${name}`, labels, (name, labelNames) =>
            new metrics.Summary({
                name,
                help: name,
                labelNames,
                registers: [registry],
                ageBuckets: conf?.ageBuckets,
                maxAgeSeconds: conf?.maxAgeSeconds,
                pruneAgedBuckets: conf?.pruneAgedBuckets ?? false,
            }));
        return new Timer(metric.labels(...Object.keys(labels).sort().map(name => labels[name])));
    }

}

/**
 * Wrap method invokation with MetricsService.timer.time().
 * @param name the name of the metric, class name will be prepended automatically. If not specified, method
 * name will be used.
 * @constructor
 */
export function Metric(name?: string | MetricConfiguration): MethodDecorator {
    const opt = option(name).map(n => {
        if (typeof name === 'string') {
            return {
                name: n
            } as MetricConfiguration;
        } else {
            return name as MetricConfiguration;
        }
    });
    return (target, key, descriptor: PropertyDescriptor) => {
        const method = descriptor.value;

        descriptor.value = new Proxy(method, {
            apply: function (target, thisArg, args) {
                const timerName = `${thisArg.constructor.name}_${opt.flatMap(n => option(n.name)).getOrElseValue(target.name)}`;
                return MetricsService.timer(timerName, {
                    pruneAgedBuckets: opt.flatMap(x => option(x.pruneAgedBuckets)).orUndefined,
                    maxAgeSeconds: opt.flatMap(x => option(x.maxAgeSeconds)).orUndefined,
                    ageBuckets: opt.flatMap(x => option(x.ageBuckets)).orUndefined,
                }, opt.flatMap(x => option(x.labels)).orUndefined)
                    .time(() => target.apply(thisArg, args));
            }
        });

        return descriptor;
    };
}

export interface TimerJson {
    '50': number;
    '90': number;
    '95': number;
    '99': number;
    count: number;
}

export interface MetricsJson {
    counters: Record<string, number>;
    histograms: Record<string, TimerJson>;
    labels: Record<string, string>;
    gauges: Record<string, any>;
    timers: Record<string, TimerJson>;
    unknown: Record<string, any>;
}

export interface TimerConfiguration {
    readonly maxAgeSeconds?: number;
    readonly ageBuckets?: number;
    readonly pruneAgedBuckets?: boolean;
}

export interface MetricConfiguration {
    readonly labels?: Labels;
    readonly name?: string;
    readonly maxAgeSeconds?: number;
    readonly ageBuckets?: number;
    readonly pruneAgedBuckets?: boolean;
}

class Timer {

    constructor(private readonly h: metrics.Summary.Internal<string>) {
    }

    time<T>(body: () => T | Promise<T>): T | Promise<T> {
        const end = this.h.startTimer();
        const res = body();
        if (res instanceof Promise) {
            return res.finally(() => {
                end();
            });
        } else {
            end();
        }
        return res;
    }

    start(): () => void {
        return this.h.startTimer();
    }
}

