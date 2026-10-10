package dev.mockingbird.payment;
public record PaymentRequest(String userId, String sku, int quantity, double amount) {}
