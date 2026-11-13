---
kind: external_dependency
name: Nginx — production frontend server
slug: nginx
category: external_dependency
category_hints:
    - vendor_identity
scope:
    - '**'
source_files:
    - frontend/Dockerfile
    - frontend/nginx.conf
    - docker-compose.yml
---

The frontend Docker image serves the built SPA through Nginx (`frontend/nginx.conf`), exposing port 80 which compose maps to host 8080. In compose the web container is the browser-facing endpoint while the API runs separately on 4000.