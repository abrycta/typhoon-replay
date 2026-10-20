package dev.krtmtthw.typhoon.shared.web;

import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.time.temporal.ChronoUnit;

import org.springframework.boot.jackson.autoconfigure.JsonMapperBuilderCustomizer;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.format.FormatterRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

import com.fasterxml.jackson.annotation.JsonInclude;

import dev.krtmtthw.typhoon.contract.model.Basin;
import dev.krtmtthw.typhoon.contract.model.CountryCode;
import dev.krtmtthw.typhoon.contract.model.RadiusKm;
import tools.jackson.core.JsonGenerator;
import tools.jackson.core.StreamWriteFeature;
import tools.jackson.databind.SerializationContext;
import tools.jackson.databind.ValueSerializer;
import tools.jackson.databind.module.SimpleModule;

/**
 * JSON and parameter binding rules from CONTRACT-GUIDE §1 and §3: optional fields are omitted (never {@code null}),
 * timestamps are RFC 3339 UTC with {@code Z} and whole seconds, decimals are written plainly. Enum query parameters
 * bind from their wire values ({@code radiusKm=100}, {@code country=PH}).
 */
@Configuration(proxyBeanMethods = false)
public class WebConfig implements WebMvcConfigurer {

    public static final DateTimeFormatter RFC3339 = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss'Z'");

    @Bean
    JsonMapperBuilderCustomizer contractJson() {
        SimpleModule timestamps = new SimpleModule("rfc3339-utc-seconds");
        timestamps.addSerializer(OffsetDateTime.class, new ValueSerializer<>() {
            @Override
            public void serialize(OffsetDateTime value, JsonGenerator gen, SerializationContext ctx) {
                gen.writeString(format(value));
            }
        });
        return builder -> builder
                .changeDefaultPropertyInclusion(incl -> incl
                        .withValueInclusion(JsonInclude.Include.NON_NULL)
                        .withContentInclusion(JsonInclude.Include.NON_NULL))
                .enable(StreamWriteFeature.WRITE_BIGDECIMAL_AS_PLAIN)
                .addModule(timestamps);
    }

    /**
     * Let TRACE reach the application (Tomcat rejects it before any filter, without our headers), so
     * {@link ContractHeadersFilter} answers it like any other undeclared method: 405 with {@code Allow}.
     */
    @Bean
    org.springframework.boot.tomcat.TomcatConnectorCustomizer traceReachesFilters() {
        return connector -> connector.setAllowTrace(true);
    }

    public static String format(OffsetDateTime t) {
        return RFC3339.format(t.withOffsetSameInstant(ZoneOffset.UTC).truncatedTo(ChronoUnit.SECONDS));
    }

    @Override
    public void addFormatters(FormatterRegistry registry) {
        registry.addConverter(String.class, RadiusKm.class, s -> RadiusKm.fromValue(Integer.valueOf(s)));
        registry.addConverter(String.class, CountryCode.class, CountryCode::fromValue);
        registry.addConverter(String.class, Basin.class, Basin::fromValue);
    }
}
