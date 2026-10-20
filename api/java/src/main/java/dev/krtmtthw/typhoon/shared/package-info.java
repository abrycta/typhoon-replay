/**
 * Cross-cutting web plumbing every module uses: RFC 9457 problems, the contract's response headers, ETags,
 * cursors, the request-body schema check, rate limiting and structured logs. Open, so modules may use any type.
 */
@ApplicationModule(displayName = "Shared web plumbing", type = ApplicationModule.Type.OPEN)
package dev.krtmtthw.typhoon.shared;

import org.springframework.modulith.ApplicationModule;
