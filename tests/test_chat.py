"""Chat loop with a fake Anthropic client: Claude asks to create an item, then replies."""
from datetime import date, timedelta

import anthropic
from anthropic.types import Message, TextBlock, ToolUseBlock, Usage


def _msg(content, stop):
    return Message(id="m", type="message", role="assistant", model="x", content=content,
                   stop_reason=stop, stop_sequence=None, usage=Usage(input_tokens=1, output_tokens=1))


def test_chat_tool_loop(client, monkeypatch):
    d = (date.today() + timedelta(days=3)).isoformat()
    script = [
        _msg([ToolUseBlock(id="t1", type="tool_use", name="create_item",
                           input={"kind": "event", "title": "Gym", "start": f"{d}T10:00"})], "tool_use"),
        _msg([TextBlock(type="text", text="Added Gym at 10:00.")], "end_turn"),
    ]

    class Fake:
        def __init__(self, *a, **k):
            self.messages = self

        def create(self, **kw):
            assert kw["tools"] and "Europe/Dublin" in kw["system"]
            return script.pop(0)

    monkeypatch.setenv("ANTHROPIC_API_KEY", "x")
    monkeypatch.setattr(anthropic, "Anthropic", Fake)
    r = client.post("/api/chat", json={"message": "gym saturday 10am"}).json
    assert r["reply"] == "Added Gym at 10:00."
    assert r["changes"][0]["result"]["end"] == f"{d}T11:00"
