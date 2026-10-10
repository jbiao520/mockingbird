package dev.mockingbird.payment;
import com.fasterxml.jackson.databind.ObjectMapper;
import okhttp3.*;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
@Component
public class BankClient {
    private final OkHttpClient httpClient = new OkHttpClient();
    private final ObjectMapper objectMapper;
    @Value("${services.bank.url}")
    private String baseUrl;
    public BankClient(ObjectMapper objectMapper) { this.objectMapper = objectMapper; }
    public BankResponse charge(PaymentRequest payment) {
        try {
            Request request = new Request.Builder().url(baseUrl + "/bank/charge")
                .post(RequestBody.create(objectMapper.writeValueAsString(payment), MediaType.parse("application/json"))).build();
            try (Response response = httpClient.newCall(request).execute()) {
                if (!response.isSuccessful() || response.body() == null) throw new IllegalStateException("Bank HTTP " + response.code());
                return objectMapper.readValue(response.body().string(), BankResponse.class);
            }
        } catch (Exception error) { throw new IllegalStateException("Bank request failed", error); }
    }
}
