package com.patchwork.bridge

import com.intellij.openapi.project.Project
import com.intellij.openapi.startup.StartupActivity

@Suppress("UnstableApiUsage")
class BridgeStartupActivity : StartupActivity.DumbAware {
    override fun runActivity(project: Project) {
        BridgeService.getInstance()
        ProjectBridgeService.getInstance(project)
    }
}
