# Shared n8n node JSON exports

Used by **insert** (`insert_pipeline.schema_store`) and **modify** (`modify_pipeline.node_schema_store`).

- `node_schemas/` — descriptors (`name`, `displayName`, `properties`, …)

Override the base directory with `N8N_WIDGET_SCHEMA_ROOT` or `WIDGET_NODE_SCHEMA_ROOT` (must contain `node_schemas/`). The Docker image sets `N8N_WIDGET_SCHEMA_ROOT=/app/schemas`.
