from __future__ import annotations

import json
import sys

from dataclasses import asdict

from .visual_plan import EngineDependencyError, build_plan, transcribe_words


def respond(payload: dict) -> dict:
    operation = payload.get("operation")
    if operation == "build_visual_plan":
        return {
            "ok": True,
            "result": build_plan(
                str(payload.get("script", "")),
                float(payload.get("targetSeconds", 8)),
                payload.get("durationSeconds"),
            ),
        }
    if operation == "transcribe":
        return {
            "ok": True,
            "result": {
                "words": [
                    asdict(word)
                    for word in transcribe_words(
                        str(payload["mediaPath"]),
                        str(payload.get("model", "base")),
                    )
                ]
            },
        }
    return {"ok": False, "error": {"code": "unknown_operation", "message": str(operation)}}


def main() -> None:
    for line in sys.stdin:
        try:
            payload = json.loads(line)
            output = respond(payload)
        except EngineDependencyError as error:
            output = {
                "ok": False,
                "error": {"code": "missing_dependency", "message": str(error)},
            }
        except Exception as error:
            output = {
                "ok": False,
                "error": {"code": "engine_error", "message": str(error)},
            }
        print(json.dumps(output), flush=True)


if __name__ == "__main__":
    main()
