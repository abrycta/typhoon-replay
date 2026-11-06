# syntax=docker/dockerfile:1.10
# Replay Java backend. Build context: the repository root (the contract lives in contracts/):
#   docker build -f api/java/Dockerfile -t typhoon-replay-java .
# Stages: bundle the contract -> Gradle bootJar -> extract -> AOT cache training run (JEP 514/515) -> JRE 25 runtime.
# Frozen showcase (docs/architecture/DECISIONS.md): base images are pinned by digest; Renovate only bumps a digest
# for a security fix (the tag stays), and the dependency lockfiles keep the jar's contents fixed.

# --- 1. The contract bundle (contracts/dist/openapi.json), generated from the split YAML -----------------------
FROM node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85 AS contract
WORKDIR /contracts
COPY contracts/package.json contracts/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY contracts/ ./
RUN npm run bundle

# --- 2. Build the jar (interfaces generated from the bundle) ---------------------------------------------------
FROM eclipse-temurin:25-jdk@sha256:83f4a7fc27df94dcc7b8de04d14cbbba8da14406f921e966969c3b09000aa507 AS build
WORKDIR /src/api/java
COPY api/java/gradlew api/java/settings.gradle.kts api/java/build.gradle.kts api/java/*.lockfile ./
COPY api/java/gradle ./gradle
RUN --mount=type=cache,target=/root/.gradle ./gradlew --no-daemon -q help
COPY --from=contract /contracts/dist/openapi.json /contract/openapi.json
COPY api/java/src ./src
RUN --mount=type=cache,target=/root/.gradle ./gradlew --no-daemon -q bootJar -Pcontract=/contract/openapi.json \
 && java -Djarmode=tools -jar build/libs/typhoon-replay-api-*.jar extract --destination /app \
 && mv /app/typhoon-replay-api-*.jar /app/app.jar

# --- 3. Runtime image with an AOT cache trained on this exact JRE and class path ------------------------------
FROM eclipse-temurin:25-jre@sha256:ecdc0adb37bde1a281c4d245a3cd535004b1fc8322d560f5b09463b248c81df0 AS runtime
RUN groupadd --system app && useradd --system --gid app --home /app app && install -d -o app -g app /app
WORKDIR /app
COPY --from=build --chown=app:app /app ./
USER app
# GC and object-header flags must match between the training run and production, or the JVM ignores the cache.
ENV JAVA_TOOL_OPTIONS="-XX:+UseSerialGC -XX:MaxRAMPercentage=60 -XX:+UseCompactObjectHeaders -Xss512k"
# Training run: start the context and exit at refresh (no database needed: nothing touches it at startup), and
# record loaded/linked classes and method profiles into app.aot (-XX:AOTCacheOutput, Java 25).
# -XX:MaxRAM=512m sizes the training heap like Render's free instance (512 MB). Without it, a build host with more
# than ~54 GB of RAM gives MaxRAMPercentage=60 a heap over 32 GB, which turns compressed oops off; the cache then
# records UseCompressedOops=false, and the 512 MB runtime (compressed oops on) rejects it ("Unable to map shared
# spaces") and starts without it.
RUN java -XX:MaxRAM=512m -XX:AOTCacheOutput=app.aot -Dspring.context.exit=onRefresh -Dlogging.level.root=warn -jar app.jar \
 && test -s app.aot
# The build's commit, a fallback only: an explicit TR_COMMIT, then Render's RENDER_GIT_COMMIT, come first
# (application.yaml tr.commit). Setting TR_COMMIT here would hide RENDER_GIT_COMMIT on Render.
ARG COMMIT_SHA=unknown
ENV TR_IMAGE_COMMIT=${COMMIT_SHA} \
    PORT=8080
EXPOSE 8080
ENTRYPOINT ["java", "-XX:AOTCache=app.aot", "-jar", "app.jar"]
