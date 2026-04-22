import org.jetbrains.intellij.platform.gradle.TestFrameworkType

plugins {
    id("java")
    kotlin("jvm") version "1.9.25"
    id("org.jetbrains.intellij.platform") version "2.3.0"
}

group = "com.patchwork"
version = providers.gradleProperty("pluginVersion").get()

repositories {
    mavenCentral()
    intellijPlatform {
        defaultRepositories()
    }
}

dependencies {
    intellijPlatform {
        intellijIdeaCommunity("2024.1")
        pluginVerifier()
        zipSigner()
        testFramework(TestFrameworkType.JUnit5)
    }

    // WebSocket client
    implementation("org.java-websocket:Java-WebSocket:1.5.7")
    // JSON
    implementation("com.google.code.gson:gson:2.10.1")

    testImplementation("org.junit.jupiter:junit-jupiter:5.10.2")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
    // IJ test framework's JUnit5TestSessionListener needs JUnit 4 on classpath
    testRuntimeOnly("junit:junit:4.13.2")
}

intellijPlatform {
    pluginConfiguration {
        id = providers.gradleProperty("pluginId").get()
        name = "Patchwork Bridge"
        version = providers.gradleProperty("pluginVersion").get()
    }

    signing {
        // configure when publishing
    }

    publishing {
        // configure when publishing
    }

    pluginVerification {
        ides {
            recommended()
        }
    }
}

kotlin {
    jvmToolchain(17)
}

tasks {
    compileKotlin {
        kotlinOptions {
            jvmTarget = "17"
            freeCompilerArgs = listOf("-Xjvm-default=all")
        }
    }

    test {
        useJUnitPlatform()
    }
}
