package dev.mockingbird.payment;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.springframework.web.reactive.function.client.WebClient;
@Component
public class RiskClient {
    private final WebClient webClient = WebClient.create();
    @Value("${services.risk.url}")
    private String baseUrl;
    public RiskResponse check(PaymentRequest request) {
        return webClient.post().uri(baseUrl + "/risk/check").bodyValue(request).retrieve().bodyToMono(RiskResponse.class).block();
    }
}
