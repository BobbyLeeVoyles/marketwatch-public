"""Claude Computer Use API wrapper for executing Robinhood actions."""

import os
import time
from pathlib import Path
from dataclasses import dataclass, field
from anthropic import Anthropic
from screen import take_screenshot, get_screen_size, execute_action


@dataclass
class ExecutionResult:
    success: bool
    actions_taken: list[str] = field(default_factory=list)
    final_message: str = ""
    error: str = ""
    screenshots_taken: int = 0


MAX_LOOPS = 20
SYSTEM_PROMPT_PATH = Path(__file__).parent / "system_prompt.md"


def load_system_prompt() -> str:
    """Load the system prompt from system_prompt.md."""
    return SYSTEM_PROMPT_PATH.read_text()


def execute(instruction: str, dry_run: bool = False) -> ExecutionResult:
    """Execute an instruction using Claude Computer Use.

    Args:
        instruction: The plain-English command (e.g., "Buy YES on 'Bitcoin above $97,000'...")
        dry_run: If True, stop before clicking Submit (navigate + fill only)
    """
    client = Anthropic()
    result = ExecutionResult(success=False)
    system_prompt = load_system_prompt()

    if dry_run:
        system_prompt += (
            "\n\n## DRY RUN MODE\n"
            "You are in DRY RUN mode. Do everything normally EXCEPT:\n"
            "- Do NOT click 'Submit Order' or any final confirmation button\n"
            "- STOP at the Review screen and report what you see\n"
            "- Report exactly what would have been submitted\n"
        )

    width, height = get_screen_size()

    # Initial screenshot
    screenshot_b64 = take_screenshot()
    result.screenshots_taken += 1

    messages = [
        {
            "role": "user",
            "content": [
                {
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": "image/png",
                        "data": screenshot_b64,
                    },
                },
                {
                    "type": "text",
                    "text": f"Execute this instruction:\n\n{instruction}",
                },
            ],
        }
    ]

    for loop in range(MAX_LOOPS):
        response = client.messages.create(
            model="claude-sonnet-4-5-20250929",
            max_tokens=1024,
            system=system_prompt,
            tools=[
                {
                    "type": "computer_20250124",
                    "name": "computer",
                    "display_width_px": width,
                    "display_height_px": height,
                    "display_number": 0,
                }
            ],
            messages=messages,
        )

        # Process response blocks
        assistant_content = response.content
        has_tool_use = False

        for block in assistant_content:
            if block.type == "text":
                result.final_message = block.text
                result.actions_taken.append(f"[TEXT] {block.text[:100]}")
            elif block.type == "tool_use":
                has_tool_use = True
                tool_input = block.input
                action_desc = f"[ACTION] {tool_input.get('action', 'unknown')}"

                if "coordinate" in tool_input:
                    coord = tool_input["coordinate"]
                    action_desc += f" at ({coord[0]}, {coord[1]})"
                if "text" in tool_input:
                    action_desc += f" text='{tool_input['text'][:50]}'"

                result.actions_taken.append(action_desc)
                print(f"  Loop {loop + 1}: {action_desc}")

                # Convert Claude CU action to pyautogui action
                cu_action = tool_input.get("action", "")
                py_action = {}

                if cu_action in ("left_click", "click"):
                    coord = tool_input.get("coordinate", [0, 0])
                    py_action = {"type": "click", "x": coord[0], "y": coord[1]}
                elif cu_action == "double_click":
                    coord = tool_input.get("coordinate", [0, 0])
                    py_action = {"type": "double_click", "x": coord[0], "y": coord[1]}
                elif cu_action == "right_click":
                    coord = tool_input.get("coordinate", [0, 0])
                    py_action = {"type": "click", "x": coord[0], "y": coord[1], "button": "right"}
                elif cu_action == "type":
                    py_action = {"type": "type", "text": tool_input.get("text", "")}
                elif cu_action == "key":
                    py_action = {"type": "key", "key": tool_input.get("text", "")}
                elif cu_action == "scroll":
                    coord = tool_input.get("coordinate", [0, 0])
                    py_action = {
                        "type": "scroll",
                        "x": coord[0],
                        "y": coord[1],
                        "amount": tool_input.get("scroll_amount", -3),
                    }
                elif cu_action == "mouse_move":
                    coord = tool_input.get("coordinate", [0, 0])
                    py_action = {"type": "mouse_move", "x": coord[0], "y": coord[1]}
                elif cu_action == "screenshot":
                    # Just take a screenshot, no physical action
                    pass
                else:
                    print(f"  [WARN] Unknown CU action: {cu_action}")

                if py_action:
                    execute_action(py_action)
                    time.sleep(0.5)  # Wait for UI to update

                # Take follow-up screenshot
                time.sleep(0.3)
                screenshot_b64 = take_screenshot()
                result.screenshots_taken += 1

                # Build tool result message
                messages.append({"role": "assistant", "content": assistant_content})
                messages.append({
                    "role": "user",
                    "content": [
                        {
                            "type": "tool_result",
                            "tool_use_id": block.id,
                            "content": [
                                {
                                    "type": "image",
                                    "source": {
                                        "type": "base64",
                                        "media_type": "image/png",
                                        "data": screenshot_b64,
                                    },
                                }
                            ],
                        }
                    ],
                })
                break  # Process one tool use at a time

        # If no tool use, Claude is done
        if not has_tool_use:
            result.success = True
            break

        # Check stop reason
        if response.stop_reason == "end_turn":
            result.success = True
            break

    return result
