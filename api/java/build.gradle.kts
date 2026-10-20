import groovy.json.JsonOutput
import groovy.json.JsonSlurper
import org.openapitools.generator.gradle.plugin.tasks.GenerateTask

plugins {
    java
    alias(libs.plugins.spring.boot)
    alias(libs.plugins.openapi.generator)
}

group = "dev.krtmtthw"
version = "0.2.0"

java {
    toolchain { languageVersion = JavaLanguageVersion.of(25) }
}

repositories { mavenCentral() }

// The contract bundle (CONTRACT-GUIDE §1). `just bundle` (or `npm --prefix contracts run bundle`) writes it;
// the Docker build bundles it in its own stage and passes -Pcontract=/path/to/openapi.json.
val contractFile: RegularFile = layout.projectDirectory.file(
    (findProperty("contract") as String?) ?: "../../contracts/dist/openapi.json"
)

dependencies {
    implementation(platform(org.springframework.boot.gradle.plugin.SpringBootPlugin.BOM_COORDINATES))
    implementation(platform(libs.spring.modulith.bom))

    implementation("org.springframework.boot:spring-boot-starter-webmvc")
    implementation("org.springframework.boot:spring-boot-starter-jdbc")
    implementation("org.springframework.boot:spring-boot-starter-validation")
    implementation("org.springframework.boot:spring-boot-starter-actuator")
    implementation("org.springframework.boot:spring-boot-starter-restclient")
    implementation("org.springframework.modulith:spring-modulith-starter-core")
    implementation("com.github.ben-manes.caffeine:caffeine")
    implementation(libs.bucket4j.core)
    implementation(libs.json.schema.validator)
    runtimeOnly("org.postgresql:postgresql")

    testImplementation("org.springframework.boot:spring-boot-starter-test")
    testImplementation("org.springframework.boot:spring-boot-starter-webmvc-test")
    testImplementation("org.springframework.boot:spring-boot-starter-jdbc-test")
    testImplementation("org.springframework.boot:spring-boot-testcontainers")
    testImplementation("org.springframework.modulith:spring-modulith-starter-test")
    testImplementation("org.springframework.modulith:spring-modulith-docs")
    testImplementation(libs.testcontainers.postgresql)
    testImplementation(libs.testcontainers.junit)
    testImplementation(libs.archunit)
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

// ---------------------------------------------------------------------------------------------------------------
// Contract-first: interfaces and models generated from the 3.1 bundle, never committed (build/generated/openapi).
// One operation is not served by an MVC handler with a generated signature, so the codegen view of the spec marks
// it x-internal (openapi-generator skips those):
//   streamLiveEvents       SseEmitter, hand-written in live/web/LiveController
// ---------------------------------------------------------------------------------------------------------------
val handWrittenOperations = setOf("streamLiveEvents")
val codegenSpec = layout.buildDirectory.file("contract/openapi.codegen.json")

val codegenView = tasks.register("codegenView") {
    description = "Writes the codegen view of the contract bundle (hand-written operations marked x-internal)."
    inputs.file(contractFile)
    inputs.property("handWritten", handWrittenOperations)
    outputs.file(codegenSpec)
    doLast {
        @Suppress("UNCHECKED_CAST")
        val spec = JsonSlurper().parse(contractFile.asFile) as MutableMap<String, Any?>
        @Suppress("UNCHECKED_CAST")
        val paths = spec["paths"] as Map<String, Map<String, Any?>>
        var marked = 0
        paths.values.forEach { item ->
            item.values.filterIsInstance<MutableMap<String, Any?>>()
                .filter { it["operationId"] in handWrittenOperations }
                .forEach { it["x-internal"] = true; marked++ }
        }
        check(marked == handWrittenOperations.size) { "expected ${handWrittenOperations.size} hand-written operations, found $marked" }
        codegenSpec.get().asFile.apply { parentFile.mkdirs(); writeText(JsonOutput.toJson(spec)) }
    }
}

val generatedDir = layout.buildDirectory.dir("generated/openapi")

tasks.named<GenerateTask>("openApiGenerate") {
    dependsOn(codegenView)
    generatorName = "spring"
    inputSpec = codegenSpec
    outputDir = generatedDir
    apiPackage = "dev.krtmtthw.typhoon.contract.api"
    modelPackage = "dev.krtmtthw.typhoon.contract.model"
    cleanupOutput = true
    globalProperties = mapOf("apis" to "", "models" to "", "supportingFiles" to "false", "modelDocs" to "false", "apiDocs" to "false")
    configOptions = mapOf(
        "interfaceOnly" to "true",
        "useTags" to "true",
        "skipDefaultInterface" to "true",
        "useSpringBoot4" to "true",
        "useJackson3" to "true",
        "useBeanValidation" to "true",
        "performBeanValidation" to "false",
        "useSpringBuiltInValidation" to "true",
        "documentationProvider" to "none",
        "annotationLibrary" to "none",
        "openApiNullable" to "false",
        "generateJsonIncludeAnnotations" to "false",
        "generateJsonSetterNullsAnnotations" to "false",
        "containerDefaultToNull" to "true",
        "dateLibrary" to "java8",
        "hideGenerationTimestamp" to "true",
        "sourceFolder" to "src/main/java",
    )
}

sourceSets.main {
    java.srcDir(generatedDir.map { it.dir("src/main/java") })
}

tasks.compileJava {
    dependsOn("openApiGenerate")
    options.compilerArgs.addAll(listOf("-parameters"))
}

// GET /v1/openapi.json serves the bundle byte for byte (CONTRACT-GUIDE §10).
tasks.processResources {
    from(contractFile) { into("contract") }
}

springBoot {
    mainClass = "dev.krtmtthw.typhoon.TyphoonApplication"
    buildInfo()
}

tasks.test {
    useJUnitPlatform()
    systemProperty("tr.contract", contractFile.asFile.absolutePath)
    systemProperty("tr.migrations", layout.projectDirectory.dir("../../contracts/db").asFile.absolutePath)
    jvmArgs("-XX:+EnableDynamicAgentLoading", "-Xshare:auto")
    testLogging { events("failed"); exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL }
}
