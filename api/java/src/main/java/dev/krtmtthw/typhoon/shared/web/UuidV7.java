package dev.krtmtthw.typhoon.shared.web;

import java.security.SecureRandom;
import java.util.UUID;

/** RFC 9562 version 7 UUIDs (48-bit Unix milliseconds, then random bits), used for fresh request ids. */
public final class UuidV7 {

    private static final SecureRandom RANDOM = new SecureRandom();

    private UuidV7() {}

    public static UUID next() {
        long millis = System.currentTimeMillis();
        long randA = RANDOM.nextInt(1 << 12);
        long msb = (millis << 16) | (0x7L << 12) | randA;
        long lsb = (RANDOM.nextLong() & 0x3FFF_FFFF_FFFF_FFFFL) | 0x8000_0000_0000_0000L;
        return new UUID(msb, lsb);
    }
}
