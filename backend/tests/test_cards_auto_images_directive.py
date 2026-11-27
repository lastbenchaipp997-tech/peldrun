# test_cards_auto_images_directive.py
from peldrun.context.generative_ui import build_generative_ui_prompt

def test_directive_variants():
    on = build_generative_ui_prompt({"enabled": True, "features": {"cards": True}})
    assert "image.ref must be an id" in on
    assert "image.query" not in on
    auto = build_generative_ui_prompt({
        "enabled": True,
        "features": {"cards": True, "cards_auto_images": True},
    })
    assert "image.query" in auto


# test_card_images_extract.py
from omweb.agent_bridge_parts.card_images import extract_card_image_queries

def test_extract_queries():
    txt = (
        '```ui\n'
        '{"type":"grid","items":['
        '{"title":"A","image":{"query":"Eiffel  Tower"}},'
        '{"title":"B","image":{"query":"eiffel tower"}},'
        '{"title":"C","image":{"query":"http://x"}},'
        ']}\n'
        '```'
    )
    assert extract_card_image_queries(txt) == ["Eiffel Tower"]


# test_card_images_no_download.py
import asyncio
from unittest.mock import patch
from omweb.agent_bridge_parts import card_images

def test_resolve_never_downloads():
    captured = {}
    class FakeTool:
        def __init__(self, workspace_root=None, **kw):
            captured["workspace_root"] = workspace_root
        async def aexecute(self, query):
            class R:
                is_error = False
                metadata = {"images": [{"image_url": "https://x/img.jpg", "title": "x"}]}
            return R()

    async def run():
        with patch("peldrun.tools.builtins.image_search.ImageSearchTool", FakeTool):
            with patch(
                "omweb.routers.image_proxy_rtr.build_proxy_url",
                lambda url, host: f"/api/search/image-proxy?url={url}",
            ):
                g, qm, used = await card_images.resolve_card_images(
                    '```ui\n{"items":[{"image":{"query":"cats"}}]}\n```',
                    [],
                    run_id="j", job_id="j", chat_id="c", project_id="p",
                )
                return g, qm, used

    g, qm, used = asyncio.run(run())
    assert captured["workspace_root"] is None
    assert len(g) == 1 and "cats" in qm and used is True
