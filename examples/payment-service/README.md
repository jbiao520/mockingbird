# Payment service acceptance fixture

Java 17+, Maven, Spring Boot. `POST /api/payment/create` calls Feign, RestTemplate, WebClient and OkHttp.

Open this directory in Mockingbird, analyze the payment API, generate and apply mocks, start WireMock, preview and apply all routes, then run the project from the Routes tab.

The original downstream addresses are loopback ports 19001–19004, which intentionally have no real service. Explicit samples are in `src/main/resources/mockingbird-contracts.json`.

Request: `{"userId":"u_001","sku":"sku_001","quantity":1,"amount":128}`.
Set Bank mock `approved` to false to observe `DECLINED`, then restore a snapshot and verify `COMPLETED`.
