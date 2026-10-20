package dev.krtmtthw.typhoon.shared;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

class DatabaseUrlEnvironmentTest {

    @Test
    void mapsANeonStyleUrlOntoJdbcProperties() {
        var props = DatabaseUrlEnvironment.toSpring(
                "postgresql://app:p%40ss+word@ep-x-pooler.ap-southeast-1.aws.neon.tech/typhoon?sslmode=require&channel_binding=require");
        assertThat(props.get("spring.datasource.url")).isEqualTo(
                "jdbc:postgresql://ep-x-pooler.ap-southeast-1.aws.neon.tech/typhoon?sslmode=require&channelBinding=require"
                        + "&prepareThreshold=0&ApplicationName=typhoon-replay-java");
        assertThat(props.get("spring.datasource.username")).isEqualTo("app");
        assertThat(props.get("spring.datasource.password")).isEqualTo("p@ss+word");
    }

    @Test
    void keepsThePortOfALocalUrl() {
        assertThat(DatabaseUrlEnvironment.toSpring("postgres://tr:tr@db:5432/typhoon?sslmode=disable").get("spring.datasource.url"))
                .isEqualTo("jdbc:postgresql://db:5432/typhoon?sslmode=disable&prepareThreshold=0&ApplicationName=typhoon-replay-java");
    }
}
