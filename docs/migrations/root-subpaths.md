# Root Export to Subpath Migration

Package `v0.1.3` introduced official subpath homes for selected advanced exports. Existing root imports remain available for compatibility, but new code should use the published subpath.

| Export | Compatibility import | Preferred import |
| --- | --- | --- |
| `HealthTracker` | `@causal-order/monitor` | `@causal-order/monitor/health` |
| `ReplayCoordinator` | `@causal-order/monitor` | `@causal-order/monitor/replay` |
| `ReplayBatch` | `@causal-order/monitor` | `@causal-order/monitor/replay` |
| `DeliveryRouter` | `@causal-order/monitor` | `@causal-order/monitor/routing` |
| `ThrottleController` | `@causal-order/monitor` | `@causal-order/monitor/throttle` |

```ts
import { ReplayCoordinator } from "@causal-order/monitor/replay";
```

This migration is non-breaking: the compatibility imports continue to follow the package's semantic-versioning guarantees. See the [API reference](../api-reference.md) for all published entrypoints.
