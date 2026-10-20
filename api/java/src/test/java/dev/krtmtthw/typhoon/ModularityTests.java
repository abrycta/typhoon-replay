package dev.krtmtthw.typhoon;

import static com.tngtech.archunit.lang.syntax.ArchRuleDefinition.noClasses;
import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;
import org.springframework.modulith.core.ApplicationModule;
import org.springframework.modulith.core.ApplicationModules;
import org.springframework.modulith.docs.Documenter;

import com.tngtech.archunit.core.domain.JavaClasses;
import com.tngtech.archunit.core.importer.ClassFileImporter;
import com.tngtech.archunit.core.importer.ImportOption;

/**
 * Module boundaries are enforced in the build: no cycles, only base-package (API) types cross modules. Contract 2.0.0
 * has no accounts, so the module set is fixed and nothing may reach for sessions, cookies or Spring Security again.
 */
class ModularityTests {

    private final ApplicationModules modules = ApplicationModules.of(TyphoonApplication.class);

    private static final JavaClasses MAIN = new ClassFileImporter()
            .withImportOption(ImportOption.Predefined.DO_NOT_INCLUDE_TESTS)
            .importPackages("dev.krtmtthw.typhoon");

    @Test
    void verifiesModuleStructure() {
        modules.verify();
    }

    @Test
    void hasExactlyTheReadOnlyModules() {
        assertThat(modules.stream().map(ApplicationModule::getIdentifier).map(Object::toString))
                .containsExactlyInAnyOrder("contract", "exposure", "live", "meta", "shared", "storms");
    }

    @Test
    void neverUsesSessionsCookiesOrSpringSecurity() {
        noClasses().should().dependOnClassesThat().resideInAnyPackage("org.springframework.security..")
                .because("contract 2.0.0 has no authentication (CONTRACT-GUIDE §9)")
                .check(MAIN);
        noClasses().should().dependOnClassesThat()
                .haveFullyQualifiedName("jakarta.servlet.http.Cookie")
                .orShould().dependOnClassesThat().haveFullyQualifiedName("jakarta.servlet.http.HttpSession")
                .because("backends neither set nor read cookies and keep no HTTP session (CONTRACT-GUIDE §9)")
                .check(MAIN);
    }

    @Test
    void writesModuleDocumentation() {
        new Documenter(modules).writeModulesAsPlantUml().writeIndividualModulesAsPlantUml().writeModuleCanvases();
    }
}
