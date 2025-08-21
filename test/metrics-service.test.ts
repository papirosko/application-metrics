import {MetricsService} from '../src/index';
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
