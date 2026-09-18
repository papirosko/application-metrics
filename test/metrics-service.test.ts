import {Metric, MetricsService} from '../src/index';
import {Gauge} from 'prom-client';

describe('MetricsService', () => {

    test('must set static labels', async () => {
        MetricsService.setStaticLabels({foo: 'bar'});
        MetricsService.counter('test').inc();

        const prom = await MetricsService.toPrometheus();
        expect(prom).toContain('foo');
    });

    test('must set private labels', async () => {
        const gauge = new Gauge({
            name: 'test_gauge',
            labelNames: ['test_label'],
            help: 'test help'
        });

        MetricsService.getInternalRegistry().registerMetric(gauge);

        gauge.set({'test_label': 'zzzeee'}, 10);

        const prom = await MetricsService.toPrometheus();
        expect(prom).toContain('zzzeee');
    });

});

describe('optional metric labels', () => {
    beforeEach(() => MetricsService.clear());

    test('preserves unlabeled return types and output', async () => {
        const counter = MetricsService.counter('requests');
        expect(MetricsService.counter('requests')).toBe(counter);
        expect((await counter.get()).name).toBe('counter_requests');
        counter.inc(2);
        MetricsService.histogram('size').observe(12);
        MetricsService.gauge('depth', () => 3);
        MetricsService.gauge('state', () => 'ready');
        MetricsService.timer('duration', {maxAgeSeconds: 60}).time(() => 42);
        const json = await MetricsService.toJson();
        expect(json.counters).toEqual({requests: 2});
        expect(json.gauges).toEqual({depth: 3, state: 'ready'});
        expect(json.histograms.size).toEqual({'50': 12, '90': 12, '95': 12, '99': 12, count: 1});
        expect(json.timers.duration.count).toBe(1);
    });

    test('reuses label names regardless of order and separates label values', async () => {
        MetricsService.counter('requests', {route: '/a', method: 'GET'}).inc();
        MetricsService.counter('requests', {method: 'GET', route: '/a'}).inc(2);
        MetricsService.counter('requests', {method: 'GET', route: '/b'}).inc(4);
        const prom = await MetricsService.toPrometheus();
        expect(prom).toContain('requests{method="GET",route="/a"} 3');
        expect(prom).toContain('requests{method="GET",route="/b"} 4');
        expect((await MetricsService.toJson()).counters).toEqual({
            'requests{method="GET",route="/a"}': 3,
            'requests{method="GET",route="/b"}': 4,
        });
        expect(await MetricsService.toConsole()).toContain('requests{method="GET",route="/b"}');
    });

    test('suffixes distinct label schemas and retains unlabeled calls', async () => {
        MetricsService.counter('requests').inc();
        MetricsService.counter('requests', {method: 'GET'}).inc(2);
        MetricsService.counter('requests', {route: '/a'}).inc(3);
        MetricsService.counter('requests', {method: 'POST'}).inc(4);
        MetricsService.counter('requests', {}).inc();
        const prom = await MetricsService.toPrometheus();
        expect(prom).toContain('requests 2');
        expect(prom).toContain('requests_1{method="GET"} 2');
        expect(prom).toContain('requests_1{method="POST"} 4');
        expect(prom).toContain('requests_2{route="/a"} 3');
    });

    test('collects independent gauge series and retains the first collector', async () => {
        let depth = 2;
        MetricsService.gauge('depth', () => depth, {queue: 'mail'});
        MetricsService.gauge('depth', () => 99, {queue: 'mail'});
        MetricsService.gauge('depth', () => 5, {queue: 'jobs'});
        expect(await MetricsService.toPrometheus()).toContain('depth{queue="mail"} 2');
        depth = 7;
        expect((await MetricsService.toJson()).gauges).toEqual({
            'depth{queue="mail"}': 7,
            'depth{queue="jobs"}': 5,
        });
    });

    test('exports all histogram series with their own quantiles and counts', async () => {
        MetricsService.histogram('size', {type: 'small'}).observe(2);
        MetricsService.histogram('size', {type: 'large'}).observe(20);
        MetricsService.histogram('size', {type: 'large'}).observe(20);
        const json = await MetricsService.toJson();
        expect(json.histograms['size{type="small"}']).toEqual({'50': 2, '90': 2, '95': 2, '99': 2, count: 1});
        expect(json.histograms['size{type="large"}']).toEqual({'50': 20, '90': 20, '95': 20, '99': 20, count: 2});
        expect(await MetricsService.toPrometheus()).toContain('size_count{type="large"} 2');
    });

    test('labels synchronous, asynchronous and manually started timers', async () => {
        const sync = MetricsService.timer('duration', {maxAgeSeconds: 60}, {operation: 'sync'});
        expect(sync.time(() => 42)).toBe(42);
        sync.start()();
        const asyncTimer = MetricsService.timer('duration', undefined, {operation: 'async'});
        await expect(asyncTimer.time(async () => 'done')).resolves.toBe('done');
        await expect(asyncTimer.time(async () => { throw new Error('failed'); })).rejects.toThrow('failed');
        const json = await MetricsService.toJson();
        expect(json.timers['duration{operation="sync"}'].count).toBe(2);
        expect(json.timers['duration{operation="async"}'].count).toBe(2);
        expect(await MetricsService.toPrometheus()).toContain('duration_count{operation="async"} 2');
    });

    test('combines static labels with metric labels and project prefixes', async () => {
        MetricsService.setProjectName('app');
        MetricsService.setStaticLabels({env: 'test'});
        MetricsService.counter('requests', {method: 'GET'}).inc();
        expect(await MetricsService.toPrometheus()).toContain('app_requests{method="GET",env="test"} 1');
    });

    test('clears labeled metrics and allows reusing their names', async () => {
        MetricsService.counter('requests', {method: 'GET'}).inc();
        MetricsService.gauge('depth', () => 2, {queue: 'mail'});
        await MetricsService.toPrometheus();
        MetricsService.clear();
        MetricsService.counter('requests', {route: '/a'}).inc();
        const prom = await MetricsService.toPrometheus();
        expect(prom).toContain('requests{route="/a"} 1');
        expect(prom).not.toContain('method=');
        expect(prom).not.toContain('depth');
    });
});


describe('metric decorator labels', () => {
    beforeEach(() => MetricsService.clear());

    test('passes labels and configuration to the timer', async () => {
        class Worker {
            @Metric({name: 'run', maxAgeSeconds: 60, labels: {operation: 'write'}})
            run(value: number): number { return value * 2; }
        }
        expect(new Worker().run(3)).toBe(6);
        expect((await MetricsService.toJson()).timers['Worker_run{operation="write"}'].count).toBe(1);
    });
});
