package dev.krtmtthw.typhoon;

import org.junit.jupiter.api.Test;
import org.springframework.modulith.core.ApplicationModules;
import org.springframework.modulith.docs.Documenter;

/** Module boundaries are enforced in the build: no cycles, only base-package (API) types cross modules. */
class ModularityTests {

    private final ApplicationModules modules = ApplicationModules.of(TyphoonApplication.class);

    @Test
    void verifiesModuleStructure() {
        modules.verify();
    }

    @Test
    void writesModuleDocumentation() {
        new Documenter(modules).writeModulesAsPlantUml().writeIndividualModulesAsPlantUml().writeModuleCanvases();
    }
}
