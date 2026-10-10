package dev.mockingbird.payment;
public record BankResponse(String transactionId, boolean approved, String message) {}
