"""Offline transport and credential-boundary checks; never calls xAI or the SaaS."""

import contextlib
import importlib.util
import io
import json
import sys
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / "grok_mcp.py"
spec = importlib.util.spec_from_file_location("tldw_grok_example", SOURCE)
grok = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = grok
spec.loader.exec_module(grok)


def configured_env():
    return {
        "XAI_API_KEY": "xai-fixture-private-key",
        "TLDW_API_TOKEN": "tldw_fixture-private-token",
        "TLDW_MCP_URL": "https://api.owner.net/mcp",
        "GROK_MODEL": "owner-selected-model",
    }


def completed(text="A timestamped account-grounded answer."):
    return {
        "status": "completed",
        "output": [
            {"type": "mcp_call", "name": "get_summary", "error": None, "output": "{}"},
            {"type": "message", "content": [{"type": "output_text", "text": text}]},
        ],
    }


class ExampleTests(unittest.TestCase):
    def test_current_environment_names_supply_private_credentials(self):
        env = configured_env()
        config = grok.config_from_env(env)
        self.assertEqual(config.personal_token, env["TLDW_API_TOKEN"])
        self.assertEqual(config.mcp_url, env["TLDW_MCP_URL"])
        env["TLDW_API_TOKEN"] = ""
        with self.assertRaises(grok.IntegrationError) as error:
            grok.config_from_env(env)
        self.assertEqual(error.exception.code, "CONFIGURATION_REQUIRED")
        self.assertEqual(error.exception.fields, ("TLDW_API_TOKEN",))

    def test_default_is_dry_run_without_requests_or_credential_values(self):
        output = io.StringIO()
        env = configured_env()
        with patch.object(grok, "post_response") as post, contextlib.redirect_stdout(output):
            self.assertEqual(grok.main([], env), 0)
        post.assert_not_called()
        data = json.loads(output.getvalue())
        self.assertEqual(data["network_requests"], 0)
        for value in env.values():
            self.assertNotIn(value, output.getvalue())

    def test_missing_settings_report_field_names_without_network(self):
        error = io.StringIO()
        with patch.object(grok, "post_response") as post, contextlib.redirect_stderr(error):
            self.assertEqual(grok.main(["--run"], {}), 1)
        post.assert_not_called()
        data = json.loads(error.getvalue())
        self.assertEqual(data["code"], "CONFIGURATION_REQUIRED")
        self.assertIn("TLDW_API_TOKEN", data["fields"])

    def test_remote_host_and_header_boundaries(self):
        config = grok.config_from_env(configured_env())
        body = grok.payload(config, "Read a completed summary.")
        tool = body["tools"][0]
        self.assertEqual(tool["headers"], {"Authorization": "Bearer " + config.personal_token})
        self.assertNotIn(config.api_key, json.dumps(body))
        self.assertEqual(set(tool["allowed_tools"]), set(grok.READ_ONLY_TOOLS))
        self.assertIn("wait_job", tool["allowed_tools"])
        self.assertFalse(body["store"])
        self.assertNotIn("require_approval", tool)
        self.assertFalse(
            set(tool["allowed_tools"])
            & {
                "analyze_media",
                "extract_transcript",
                "cancel_job",
                "mark_transcript_read",
            }
        )
        self.assertEqual(
            set(grok.READ_ONLY_TOOLS),
            {
                "account_usage",
                "list_jobs",
                "get_job",
                "wait_job",
                "get_summary",
                "get_transcript",
                "list_transcripts",
                "get_saved_transcript",
            },
        )
        self.assertNotIn(config.api_key, repr(config))
        self.assertNotIn(config.personal_token, repr(config))

    def test_public_https_endpoint_rejects_local_and_credential_urls(self):
        for url in (
            "http://api.owner.net/mcp",
            "https://localhost/mcp",
            "https://api.localhost/mcp",
            "https://127.0.0.1/mcp",
            "https://10.0.0.1/mcp",
            "https://[::1]/mcp",
            # This remains reserved after the operator's endpoint template is rendered.
            "https://reserved.invalid/mcp",
            "https://key:secret@api.owner.net/mcp",
            "https://api.owner.net/mcp?token=secret",
            "https://api.owner.net/mcp#fragment",
            "https://api.owner.net/mcp/other",
            "https://api.owner.net/mcp\n",
        ):
            with self.subTest(url=url), self.assertRaises(grok.IntegrationError) as error:
                grok.public_mcp_url(url)
            self.assertEqual(error.exception.code, "PUBLIC_HTTPS_MCP_URL_REQUIRED")

    def test_redirects_never_receive_either_credential(self):
        with self.assertRaises(grok.IntegrationError) as error:
            grok.RejectRedirects().redirect_request(
                None, None, 307, "private-message", {}, "https://foreign.net/private-secret"
            )
        self.assertEqual(str(error.exception), "XAI_REDIRECT_REFUSED")

    def test_transport_uses_fixed_host_bounded_timeout_and_response(self):
        config = grok.config_from_env(configured_env())

        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *_):
                pass

            def read(self, size):
                self_size.append(size)
                return json.dumps(completed()).encode()

        self_size = []
        with patch.object(grok.urllib.request, "build_opener") as factory:
            factory.return_value.open.return_value = Response()
            result = grok.post_response(config, grok.payload(config, "Read my summary."))
            request = factory.return_value.open.call_args.args[0]
            self.assertEqual(request.full_url, "https://api.x.ai/v1/responses")
            self.assertEqual(request.get_header("Authorization"), "Bearer " + config.api_key)
            self.assertEqual(factory.return_value.open.call_args.kwargs["timeout"], 60)
        self.assertEqual(self_size, [grok.MAX_RESPONSE_BYTES + 1])
        self.assertEqual(result["status"], "completed")

    def test_rejected_credentials_do_not_render_provider_body(self):
        config = grok.config_from_env(configured_env())
        with patch.object(grok.urllib.request, "build_opener") as factory:
            factory.return_value.open.side_effect = urllib.error.HTTPError(
                grok.XAI_RESPONSES_URL,
                401,
                config.api_key,
                {},
                io.BytesIO(config.personal_token.encode()),
            )
            with self.assertRaises(grok.IntegrationError) as error:
                grok.post_response(config, grok.payload(config, "Read my summary."))
        self.assertEqual(str(error.exception), "XAI_HTTP_401")

    def test_large_response_and_timeout_fail_without_body_leakage(self):
        config = grok.config_from_env(configured_env())
        with patch.object(grok.urllib.request, "build_opener") as factory:
            factory.return_value.open.return_value.__enter__.return_value.read.return_value = (
                b"x" * (grok.MAX_RESPONSE_BYTES + 1)
            )
            with self.assertRaises(grok.IntegrationError) as error:
                grok.post_response(config, {})
            self.assertEqual(error.exception.code, "XAI_RESPONSE_TOO_LARGE")
            factory.return_value.open.side_effect = TimeoutError(config.api_key)
            with self.assertRaises(grok.IntegrationError) as error:
                grok.post_response(config, {})
            self.assertEqual(error.exception.code, "XAI_TRANSPORT_ERROR")

    def test_model_cannot_present_an_ungrounded_or_failed_tool_answer_as_verified(self):
        response = completed()
        response["output"] = response["output"][1:]
        with self.assertRaises(grok.IntegrationError) as error:
            grok.answer_text(response)
        self.assertEqual(error.exception.code, "MCP_WAS_NOT_USED")
        response = completed()
        response["output"][0]["output"] = '{"error":{"code":"TOKEN_SCOPE_REQUIRED"}}'
        with self.assertRaises(grok.IntegrationError) as error:
            grok.answer_text(response)
        self.assertEqual(error.exception.code, "MCP_TOOL_FAILED")

    def test_live_answer_only_is_printed_and_credentials_are_redacted(self):
        env, output = configured_env(), io.StringIO()
        text = f"A source answer {env['XAI_API_KEY']} {env['TLDW_API_TOKEN']}"
        response = completed(text)
        response["private_debug"] = {"do_not_dump": "provider-body-marker"}
        with (
            patch.object(grok, "post_response", return_value=response),
            contextlib.redirect_stdout(output),
        ):
            self.assertEqual(grok.main(["--run"], env), 0)
        self.assertIn("A source answer", output.getvalue())
        self.assertNotIn(env["XAI_API_KEY"], output.getvalue())
        self.assertNotIn(env["TLDW_API_TOKEN"], output.getvalue())
        self.assertNotIn("provider-body-marker", output.getvalue())


if __name__ == "__main__":
    unittest.main()
