package com.patchwork.bridge

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.WindowManager
import java.awt.event.WindowEvent
import java.awt.event.WindowFocusListener

/**
 * Project-level service.
 * Tracks which project's frame is focused and registers it as the active project
 * in BridgeService. Uses a WindowFocusListener on the IDE frame.
 */
@Service(Service.Level.PROJECT)
class ProjectBridgeService(val project: Project) {

    companion object {
        private val LOG = Logger.getInstance(ProjectBridgeService::class.java)

        fun getInstance(project: Project): ProjectBridgeService =
            project.getService(ProjectBridgeService::class.java)
    }

    private val focusListener = object : WindowFocusListener {
        override fun windowGainedFocus(e: WindowEvent) {
            BridgeService.getInstance().setActiveProject(project)
        }
        override fun windowLostFocus(e: WindowEvent) {
            // Intentionally left empty: keep last-focused project as active
            // so handlers have a project even when focus moves to a tool window.
        }
    }

    init {
        LOG.debug("ProjectBridgeService init: ${project.name}")
        attachListener()
    }

    private fun attachListener() {
        val frame = WindowManager.getInstance().getFrame(project)
        if (frame != null) {
            frame.addWindowFocusListener(focusListener)
            // Claim active project immediately if this frame is focused right now
            if (frame.isFocused) {
                BridgeService.getInstance().setActiveProject(project)
            }
        } else {
            // Frame not yet created (rare during startup). Post to the EDT queue
            // so it runs after the frame is shown.
            ApplicationManager.getApplication().invokeLater {
                val f = WindowManager.getInstance().getFrame(project) ?: return@invokeLater
                f.addWindowFocusListener(focusListener)
                if (f.isFocused) BridgeService.getInstance().setActiveProject(project)
            }
        }
    }

    fun dispose() {
        val frame = WindowManager.getInstance().getFrame(project)
        frame?.removeWindowFocusListener(focusListener)

        val bridge = BridgeService.getInstance()
        if (bridge.activeProject == project) {
            bridge.setActiveProject(null)
        }
    }
}
