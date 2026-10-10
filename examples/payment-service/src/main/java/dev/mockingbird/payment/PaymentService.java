package dev.mockingbird.payment;
import java.util.Map;
import org.springframework.stereotype.Service;
@Service
public class PaymentService {
    private final UserClient userClient;
    private final InventoryClient inventoryClient;
    private final RiskClient riskClient;
    private final BankClient bankClient;
    public PaymentService(UserClient userClient, InventoryClient inventoryClient, RiskClient riskClient, BankClient bankClient) {
        this.userClient = userClient; this.inventoryClient = inventoryClient; this.riskClient = riskClient; this.bankClient = bankClient;
    }
    public Map<String, Object> createPayment(PaymentRequest request) {
        UserResponse user = userClient.getUser(request.userId());
        if (!user.active()) return Map.of("status", "USER_INACTIVE");
        InventoryResponse inventory = inventoryClient.reserve(request);
        if (!inventory.available()) return Map.of("status", "OUT_OF_STOCK");
        RiskResponse risk = riskClient.check(request);
        if (!risk.approved()) return Map.of("status", "RISK_REJECTED");
        BankResponse bank = bankClient.charge(request);
        return Map.of("status", bank.approved() ? "COMPLETED" : "DECLINED", "user", user, "inventory", inventory, "risk", risk, "bank", bank);
    }
}
