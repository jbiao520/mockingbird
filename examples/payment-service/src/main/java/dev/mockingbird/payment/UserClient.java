package dev.mockingbird.payment;
import org.springframework.cloud.openfeign.FeignClient;
import org.springframework.web.bind.annotation.*;
@FeignClient(name = "user", url = "${services.user.url}")
public interface UserClient {
    @GetMapping("/users/{userId}")
    UserResponse getUser(@PathVariable("userId") String userId);
}
