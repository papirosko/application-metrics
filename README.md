A set of metrics used for analyzing application state, based on [prometheus](https://prometheus.io/docs/concepts/metric_types/) metrics.

Usage
=====
```
npm i application-metrics
```

Counter
=======
```typescript
import {MetricsService} from 'application-metrics';


for (let i = 0; i < 100; i++) {
    MetricsService.counter('items_processed').inc();
}
```

Labels
======
```typescript
import {MetricsService} from 'application-metrics';

const conf = {};// read conf  
MetricsService.label('conf_value', conf.someValue)
```

Timers
======
```typescript
import {MetricsService} from 'application-metrics';

function process(): void {
    for (let i = 0; i < 100; i++) {
        // do some stuff
    }
}

async function processAsync(): Promise<void> {
    for (let i = 0; i < 100; i++) {
        // do some stuff
    }
}

MetricsService.timer('process_ms').time(() => process());
MetricsService.timer('process_async_ms').time(() => processAsync());
```

or use `@Metric()` to observe the method:

```typescript
import {MetricsService} from 'application-metrics';

class EntriesDao {
    
    @Metric('saveEntries')
    async saveEntries(entries: object[]): Promise<void> {
        // ...
    }
}
```

Metric name can be skipped, the method name will be used instead:
```typescript
import {MetricsService} from 'application-metrics';

class EntriesDao {
    
    @Metric()
    async saveEntries(entries: object[]): Promise<void> {
        // ...
    }
}
```

You can also pass parameters to the underlying summary object. See [prom-client summary documentation](https://github.com/siimon/prom-client?tab=readme-ov-file#configuration-2).
```typescript
import {MetricsService} from 'application-metrics';

class EntriesDao {
    
    @Metric({maxAgeSeconds: 300, ageBuckets: 5, pruneAgedBuckets: true})
    async saveEntries(entries: object[]): Promise<void> {
        // ...
    }
}
```


Gauges
======
```typescript
import {MetricsService} from 'application-metrics';

MetricsService.gauge('memory_external', () => process.memoryUsage().external);
MetricsService.gauge('memory_rss', () => process.memoryUsage().rss);
MetricsService.gauge('memory_heapTotal', () => process.memoryUsage().heapTotal);
MetricsService.gauge('memory_heapUsed', () => process.memoryUsage().heapUsed);
```

Histograms
======

```typescript
import {MetricsService} from 'application-metrics';
import * as fs from 'fs';

const files = fs.readdirSync('.');
files.forEach(f => {
    MetricsService.histogram('file_size_bytes').observe(fs.statSync(f).size);
});

MetricsService.toConsole().then(msg => {
    console.log(msg);
});
```

outputs something like 
```
****** METRICS ******
Histograms:       
  file_size_bytes:  {"50":543,"90":11328,"95":300966,"99":397512,"count":15}
```



Output
======
You can periodically print metrics to console:
```typescript
import {MetricsService} from 'application-metrics';

MetricsService.gauge('memory_external', () => process.memoryUsage().external);
MetricsService.gauge('memory_rss', () => process.memoryUsage().rss);
MetricsService.gauge('memory_heapTotal', () => process.memoryUsage().heapTotal);
MetricsService.gauge('memory_heapUsed', () => process.memoryUsage().heapUsed);


setInterval(async () => {
    console.log(await MetricsService.toConsole());
}, 60000);
```
will produce something like:
```
 ****** METRICS ******
Gauges:                                                   
  memory_external:                           104,763,523
  memory_rss:                                440,160,256
  memory_heapTotal:                          255,873,024
  memory_heapUsed:                           229,729,176
```

Also, you can have an endpoint to show metrics as json or in prometheus format (example uses [NestJS](https://nestjs.com/)):

```typescript
import {MetricsService} from 'application-metrics';
import {Controller, Get, Header} from '@nestjs/common';
import {
    ApiOkResponse,
    ApiOperation,
    ApiProduces,
    ApiTags,
} from '@nestjs/swagger';

@Controller()
@ApiTags('metrics')
export class MetricsController {
    
    @ApiOperation({
        description: 'Get metrics in json format',
        summary: 'Get metrics in json format',
    })
    @ApiOkResponse({description: 'Success', type: Object})
    @Get('metrics')
    @Header('Content-Type', 'application/json')
    async getMetrics(): Promise<string> {
        return JSON.stringify(await MetricsService.toJson(), null, 4);
    }

    
    @ApiOperation({
        description: 'prometheus metrics export endpoint',
        summary: 'Get metrics in prometheus format',
    })
    @ApiOkResponse({description: 'Success', type: String})
    @ApiProduces('text/plain')
    @Get('prometheusmetrics')
    @Header('Content-Type', 'text/plain')
    async getPrometheusMetrics(): Promise<string> {
        return MetricsService.toPrometheus();
    }
}
```
```shell
curl localhost:3000/metrics
```
```
{
    "gauges": {
        "memory_external": 17936815,
        "memory_rss": 291016704,
        "memory_heapTotal": 202420224,
        "memory_heapUsed": 180871624
    }
}
```



```shell
curl localhost:3000/prometheusmetrics
```
```
# HELP gauge_memory_external gauge_memory_external
# TYPE gauge_memory_external gauge
memory_external 85052806

# HELP gauge_memory_rss gauge_memory_rss
# TYPE gauge_memory_rss gauge
memory_rss 401350656

# HELP gauge_memory_heapTotal gauge_memory_heapTotal
# TYPE gauge_memory_heapTotal gauge
memory_heapTotal 224940032

# HELP gauge_memory_heapUsed gauge_memory_heapUsed
# TYPE gauge_memory_heapUsed gauge
memory_heapUsed 185016864
```

Metric labels
=============
Metric calls accept an optional map of label names to string values:

```typescript
MetricsService.counter('requests', {method: 'GET', route: '/items'}).inc();
MetricsService.histogram('response_size', {route: '/items'}).observe(512);
MetricsService.gauge('queue_depth', () => queue.length, {queue: 'mail'});
MetricsService.timer('request_duration', undefined, {route: '/items'}).time(() => process());
// Existing timer configuration remains the second argument.
MetricsService.timer('request_duration', {maxAgeSeconds: 300}, {route: '/items'}).start();
```

The `@Metric` decorator also accepts labels in its configuration:
`@Metric({name: 'save', labels: {operation: 'write'}})`.

Label order does not matter. Different values create separate series of the same
metric. Different sets of label names for the same metric name receive numeric
suffixes (`requests_1`, `requests_2`, etc.), in registration order.
Existing calls without labels continue to work. Histograms retain their existing
summary behavior. JSON and console output identify labeled series using keys such
as `requests{method="GET",route="/items"}`, while unlabeled keys remain unchanged.
Use `setStaticLabels({env: 'production'})` to add labels to every Prometheus metric;
`label(name, value)` continues to provide separate JSON/console metadata.
