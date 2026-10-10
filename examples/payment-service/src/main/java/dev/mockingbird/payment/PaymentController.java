package dev.mockingbird.payment;
import java.util.Map;
import org.springframework.web.bind.annotation.*;
@RestController
@RequestMapping("/api/payment")
public class PaymentController {
    private final PaymentService paymentService;
    public PaymentController(PaymentService paymentService) { this.paymentService = paymentService; }
    @PostMapping("/create")
    public Map<String, Object> createPayment(@RequestBody PaymentRequest request) {
        return paymentService.createPayment(request);
    }
    @GetMapping("/status")
    public Map<String, Object> getStatus() {
        return Map.of("service", "payment-service", "status", "ready");
    }
}
