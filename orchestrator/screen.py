"""Screen interaction utilities for Claude Computer Use."""

import base64
import io
import pyautogui
from PIL import Image


def take_screenshot() -> str:
    """Capture the screen and return as base64 PNG."""
    screenshot = pyautogui.screenshot()
    buffer = io.BytesIO()
    screenshot.save(buffer, format="PNG")
    return base64.standard_b64encode(buffer.getvalue()).decode("utf-8")


def get_screen_size() -> tuple[int, int]:
    """Return (width, height) of the primary screen."""
    size = pyautogui.size()
    return size.width, size.height


def execute_action(action: dict) -> None:
    """Execute a computer use action from Claude's response.

    Supports: click, type, key, scroll, mouse_move
    """
    action_type = action.get("type", "")

    if action_type == "click":
        x = action["x"]
        y = action["y"]
        button = action.get("button", "left")
        pyautogui.click(x, y, button=button)

    elif action_type == "double_click":
        x = action["x"]
        y = action["y"]
        pyautogui.doubleClick(x, y)

    elif action_type == "type":
        text = action["text"]
        pyautogui.typewrite(text, interval=0.02)

    elif action_type == "key":
        keys = action["key"]
        pyautogui.hotkey(*keys.split("+"))

    elif action_type == "scroll":
        x = action.get("x", 0)
        y = action.get("y", 0)
        amount = action.get("amount", -3)
        pyautogui.scroll(amount, x=x, y=y)

    elif action_type == "mouse_move":
        x = action["x"]
        y = action["y"]
        pyautogui.moveTo(x, y)

    else:
        print(f"[SCREEN] Unknown action type: {action_type}")
