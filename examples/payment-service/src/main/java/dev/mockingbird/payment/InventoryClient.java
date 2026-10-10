package dev.mockingbird.payment;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestTemplate;
@Component
public class InventoryClient {
    private final RestTemplate restTemplate = new RestTemplate();
    @Value("${services.inventory.url}")
    private String baseUrl;
    public InventoryResponse reserve(PaymentRequest request) {
        return restTemplate.postForObject(baseUrl + "/inventory/reserve", request, InventoryResponse.class);
    }
}
