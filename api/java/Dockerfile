# syntax=docker/dockerfile:1.10
# Typhoon Replay Java backend. Build context: the repository root (the contract lives in contracts/):
#   docker build -f api/java/Dockerfile -t typhoon-replay-java .
# Stages: bundle the contract -> Gradle bootJar -> extract -> AOT cache training run (JEP 514/515) -> JRE 25 runtime.

# --- 1. The contract bundle (contracts/dist/openapi.json), generated from the split YAML -----------------------
FROM node:24-alpine AS contract
WORKDIR /contracts
COPY contracts/package.json contracts/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY contracts/ ./
RUN npm run bundle

# --- 2. Build the jar (interfaces generated from the bundle) ---------------------------------------------------
FROM eclipse-temurin:25-jdk AS build
WORKDIR /src/api/java
COPY api/java/gradlew api/java/settings.gradle.kts api/java/build.gradle.kts ./
COPY api/java/gradle ./gradle
RUN --mount=type=cache,target=/root/.gradle ./gradlew --no-daemon -q help
COPY --from=contract /contracts/dist/openapi.json /contract/openapi.json
COPY api/java/src ./src
RUN --mount=type=cache,target=/root/.gradle ./gradlew --no-daemon -q bootJar -Pcontract=/contract/openapi.json \
 && java -Djarmode=tools -jar build/libs/typhoon-replay-api-*.jar extract --destination /app \
 && mv /app/typhoon-replay-api-*.jar /app/app.jar

# --- 3. Runtime image with an AOT cache trained on this exact JRE and class path ------------------------------
FROM eclipse-temurin:25-jre AS runtime
RUN groupadd --system app && useradd --system --gid app --home /app app && install -d -o app -g app /app
WORKDIR /app
COPY --from=build --chown=app:app /app ./
USER app
# GC and object-header flags must match between the training run and production, or the JVM ignores the cache.
ENV JAVA_TOOL_OPTIONS="-XX:+UseSerialGC -XX:MaxRAMPercentage=60 -XX:+UseCompactObjectHeaders -Xss512k"
# Training run: start the context and exit at refresh (no database needed: nothing touches it at startup), and
# record loaded/linked classes and method profiles into app.aot (-XX:AOTCacheOutput, Java 25).
RUN java -XX:AOTCacheOutput=app.aot -Dspring.context.exit=onRefresh -Dlogging.level.root=warn -jar app.jar \
 && test -s app.aot
ARG COMMIT_SHA=unknown
ENV TR_COMMIT=${COMMIT_SHA} \
    PORT=8080
EXPOSE 8080
ENTRYPOINT ["java", "-XX:AOTCache=app.aot", "-jar", "app.jar"]
