import * as metrics from 'prom-client';
import {Collection, identity, option} from 'scats';

export type GaugeValueCollector = () => any;

export namespace MetricsService {

    export const registry = new metrics.Registry();
    const labels = new Map<string, string>();
    const gauges = new Map<string, GaugeValueCollector>();

    let metricsPrefix = '';

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
        registry.clear();
        metricsPrefix = '';
    }


    export function counter(name: string): metrics.Counter<string> {
        const counterMetricName = `counter_${metricsPrefix}${name}`;
        let existing = registry.getSingleMetric(counterMetricName) as metrics.Counter<string>;
        if (!existing) {
            existing = new metrics.Counter({
                name: counterMetricName,
                help: counterMetricName,
            });
            registry.registerMetric(existing);
        }

        return existing;
    }


    export function histogram(name: string): metrics.Summary<string> {
        const counterMetricName = `histogram_${metricsPrefix}${name}`;
        let existing = registry.getSingleMetric(counterMetricName) as metrics.Summary<string>;
        if (!existing) {
            existing = new metrics.Summary({
                name: counterMetricName,
                help: counterMetricName,
            });
            registry.registerMetric(existing);
        }

        return existing;
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
        gauges.forEach((valueCollector, key) => {
            const value = valueCollector();
            if (!isNaN(value)) {
                const numGaugeMetricName = `gauge_${key}`;
                let existing = registry.getSingleMetric(numGaugeMetricName) as metrics.Gauge<string>;
                if (!existing) {
                    existing = new metrics.Gauge({
                        name: numGaugeMetricName,
                        help: numGaugeMetricName,
                    });
                    registry.registerMetric(existing);
                }
                existing.set(value);
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
        gauges.forEach((value, key) => {
            res.gauges[key] = value();
        });

        const arrayOfMetrics = Collection.from(await registry.getMetricsAsArray())
            .sort((a, b) => a.name.localeCompare(b.name));
        for (const metric of arrayOfMetrics) {
            if (metric.name.startsWith('counter_')) {
                const cnt = registry.getSingleMetric(metric.name) as any;
                res.counters[metric.name.replace('counter_', '')] = (Object.values(cnt.hashMap)[0] as any).value;
            } else if (metric.name.startsWith('gauge_')) {
                const cnt = registry.getSingleMetric(metric.name) as any;
                res.gauges[metric.name.replace('gauge_', '')] = (Object.values(cnt.hashMap)[0] as any).value;
            } else if (metric.name.startsWith('timer_')) {
                const cnt = registry.getSingleMetric(metric.name) as any;
                const values = await cnt.get();
                res.timers[metric.name.replace('timer_', '')] = {
                    '50': option(values.values[2]).map(x => x.value).orUndefined,
                    '90': option(values.values[3]).map(x => x.value).orUndefined,
                    '95': option(values.values[4]).map(x => x.value).orUndefined,
                    '99': option(values.values[5]).map(x => x.value).orUndefined,
                    count: option(values.values[8]).map(x => x.value).orUndefined,
                };
            } else if (metric.name.startsWith('histogram_')) {
                const h = registry.getSingleMetric(metric.name) as any;
                const values = await h.get();
                res.histograms[metric.name.replace('histogram_', '')] = {
                    '50': values.values[2].value,
                    '90': values.values[3].value,
                    '95': values.values[4].value,
                    '99': values.values[5].value,
                    count: values.values[8].value,
                };
            } else {
                res.unknown[metric.name] = registry.getSingleMetricAsString(
                    metric.name,
                );
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

    export function gauge(name: string, value: GaugeValueCollector): void {
        const gaugeMetricName = `${metricsPrefix}${name}`;
        if (!gauges.has(gaugeMetricName)) {
            gauges.set(gaugeMetricName, value);
        }
    }

    export function timer(name: string, conf?: TimerConfiguration): Timer {
        const timerMetricName = `timer_${metricsPrefix}${name}`;
        let existing = registry.getSingleMetric(timerMetricName) as metrics.Summary<string>;
        if (!existing) {
            existing = new metrics.Summary({
                name: timerMetricName,
                help: timerMetricName,
                ageBuckets: option(conf).map(x => x.ageBuckets).orUndefined,
                maxAgeSeconds: option(conf).map(x => x.maxAgeSeconds).orUndefined,
                pruneAgedBuckets: option(conf).map(x => x.pruneAgedBuckets).getOrElseValue(false),
            });
            registry.registerMetric(existing);
        }

        return new Timer(existing);
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
                })
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
    readonly name?: string;
    readonly maxAgeSeconds?: number;
    readonly ageBuckets?: number;
    readonly pruneAgedBuckets?: boolean;
}

class Timer {

    constructor(private readonly h: metrics.Summary<string>) {
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

