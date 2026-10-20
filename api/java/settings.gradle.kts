// Frozen showcase: the settings plugin classpath is locked too (settings-gradle.lockfile).
buildscript {
    configurations.classpath { resolutionStrategy.activateDependencyLocking() }
}

plugins {
    // Lets CI and fresh machines download the Java 25 toolchain when it is not installed.
    id("org.gradle.toolchains.foojay-resolver-convention") version "1.0.0"
}

rootProject.name = "typhoon-replay-api"
