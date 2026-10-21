package dev.krtmtthw.typhoon;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.ConfigurationPropertiesScan;
import org.springframework.modulith.Modulithic;

/**
 * Replay API, Java implementation (CONTRACT-GUIDE §0: one contract, four interchangeable backends).
 *
 * <p>Application modules (Spring Modulith): {@code shared} (open: web plumbing), {@code meta}, {@code storms},
 * {@code exposure}, {@code live}, plus the generated {@code contract} interfaces. Contract 2.0.0: no accounts.
 */
@Modulithic(systemName = "Replay API", sharedModules = "shared")
@SpringBootApplication
@ConfigurationPropertiesScan
public class TyphoonApplication {

    public static void main(String[] args) {
        SpringApplication.run(TyphoonApplication.class, args);
    }
}
