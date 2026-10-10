package dev.mockingbird.payment;
import java.util.Map;
import org.springframework.web.bind.annotation.*;
import org.springframework.http.ResponseEntity;
@RestControllerAdvice
public class ApiErrors {
    @ExceptionHandler(Exception.class)
    public ResponseEntity<Map<String, Object>> handle(Exception exception) {
        return ResponseEntity.status(502).body(Map.of("error", "DOWNSTREAM_FAILURE", "message", exception.getMessage() == null ? "Request failed" : exception.getMessage()));
    }
}
