package dev.krtmtthw.typhoon.shared.logging;

import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.Map;

import org.springframework.boot.json.JsonWriter;
import org.springframework.boot.logging.structured.StructuredLogFormatter;
import org.springframework.core.env.Environment;

import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.classic.spi.IThrowableProxy;
import ch.qos.logback.classic.spi.ThrowableProxyUtil;

/**
 * One JSON object per line with the field names every backend uses (CONTRACT-GUIDE §11):
 * {@code ts, level, msg, requestId, impl, method, path, status, durMs}, plus {@code logger} and {@code error}.
 * Wired with {@code logging.structured.format.console}.
 */
public class JsonLineFormatter implements StructuredLogFormatter<ILoggingEvent> {

    private static final DateTimeFormatter TS = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'")
            .withZone(ZoneOffset.UTC);
    private static final Map<String, Boolean> NUMERIC = Map.of("status", true, "durMs", true);

    private final String impl;
    private final JsonWriter<ILoggingEvent> writer;

    public JsonLineFormatter(Environment environment) {
        this.impl = environment.getProperty("tr.impl", "java");
        this.writer = JsonWriter.<ILoggingEvent>of(members -> {
            members.add("ts", e -> TS.format(Instant.ofEpochMilli(e.getTimeStamp())));
            members.add("level", e -> e.getLevel().toString().toLowerCase());
            members.add("msg", ILoggingEvent::getFormattedMessage);
            members.add("impl", e -> impl);
            members.add("logger", ILoggingEvent::getLoggerName);
            members.from(ILoggingEvent::getMDCPropertyMap).usingPairs((mdc, pairs) -> mdc.forEach((k, v) -> {
                if (NUMERIC.containsKey(k)) {
                    try {
                        pairs.accept(k, Long.parseLong(v));
                        return;
                    } catch (NumberFormatException ignored) {
                        // fall through and log as text
                    }
                }
                pairs.accept(k, v);
            }));
            members.add("error", ILoggingEvent::getThrowableProxy).whenNotNull().as(JsonLineFormatter::stack);
        }).withNewLineAtEnd();
    }

    @Override
    public String format(ILoggingEvent event) {
        return writer.writeToString(event);
    }

    private static String stack(IThrowableProxy proxy) {
        return ThrowableProxyUtil.asString(proxy);
    }
}
