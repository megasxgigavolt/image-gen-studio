# Legacy Migration Map

`legacy/prototype/image_gen_studio.py` is a behavioral reference, not the new architecture.

## Reuse after extraction and tests

- Image settings option lists
- Prompt extraction rules
- Three-layer prompt composition behavior
- Gemini image request behavior
- OpenAI suggestion and refinement behavior
- Retry lessons from bulk generation
- File naming and version discovery rules

## Redesign

- Widget-bound state
- JSON settings and generation-state persistence
- Thread creation and callback orchestration
- Bulk dialog job ownership
- Provider construction
- Logging configuration
- Approval/pending image workflow
- Excel as an integration contract

No production module may import `legacy/prototype/image_gen_studio.py`.

