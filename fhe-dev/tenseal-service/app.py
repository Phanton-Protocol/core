import json
import os
import time
from Crypto.Hash import keccak
import tenseal as ts
from eth_account import Account
from flask import Flask, jsonify, request

app = Flask(__name__)


def _now_ms():
    return str(int(time.time() * 1000))

_secret_ctx = None
_signer_account = None


def keccak256(data: bytes) -> bytes:
    h = keccak.new(digest_bits=256)
    h.update(data)
    return h.digest()


def keccak256_hex_utf8(s: str) -> str:
    return "0x" + keccak256(str(s).encode("utf-8")).hex()


def get_secret_context():
    global _secret_ctx
    if _secret_ctx is None:
        _secret_ctx = ts.context(
            ts.SCHEME_TYPE.CKKS,
            poly_modulus_degree=4096,
            coeff_mod_bit_sizes=[40, 20, 40],
        )
        _secret_ctx.generate_galois_keys()
        _secret_ctx.global_scale = 2**20
    return _secret_ctx


# ---------- Phase 3: signed match attestation ----------
#
# The matching service holds an ECDSA secp256k1 key whose address is published
# via /attestation-pubkey. After running the homomorphic compare, the service
# computes a deterministic decisionHash over the canonical compare payload
# (excluding the signature) and signs it. The relayer carries that signed
# attestation through to the on-chain settlement; the contract verifies an
# operator-quorum signature over the on-chain artifact (Module 6), and Phase 4
# wires this service attestation into that flow.

def get_service_signer():
    global _signer_account
    if _signer_account is None:
        pk_hex = os.environ.get("MATCHING_SERVICE_PRIVATE_KEY", "0x" + "11" * 32)
        if pk_hex.startswith("0x") or pk_hex.startswith("0X"):
            pk_hex = pk_hex[2:]
        _signer_account = Account.from_key(bytes.fromhex(pk_hex))
    return _signer_account


def stable_stringify(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sign_decision_digest(digest_hex: str) -> str:
    acct = get_service_signer()
    digest = bytes.fromhex(digest_hex[2:] if digest_hex.startswith("0x") else digest_hex)
    if len(digest) != 32:
        raise ValueError("decision digest must be 32 bytes")
    sig = Account._sign_hash(digest, private_key=acct.key)
    return "0x" + bytes(sig.signature).hex()


def he_decrypt_first(blob_hex: str) -> float:
    sec = get_secret_context()
    raw = blob_hex[2:] if blob_hex.startswith("0x") else blob_hex
    b = bytes.fromhex(raw)
    v = ts.ckks_vector_from(sec, b)
    decrypted = v.decrypt()
    return float(decrypted[0])


def safe_int_str(value) -> str:
    try:
        n = int(round(float(value)))
    except (TypeError, ValueError):
        n = 0
    if n < 0:
        n = 0
    return str(n)


@app.get("/health")
def health():
    return jsonify({"status": "ok", "service": "tenseal-fhe-demo"})


@app.get("/public-key")
def public_key():
    sec = get_secret_context()
    pub_bytes = sec.serialize(save_public_key=True, save_secret_key=False, save_galois_keys=True)
    return jsonify({"publicKey": "0x" + pub_bytes.hex(), "scheme": "CKKS", "library": "tenseal"})


@app.post("/encrypt")
def encrypt():
    body = request.get_json(silent=True) or {}
    sec = get_secret_context()
    try:
        amt = float(body.get("amount", 0))
    except (TypeError, ValueError):
        amt = 0.0
    vec = ts.ckks_vector(sec, [amt])
    blob = vec.serialize()
    out = dict(body)
    out["_ckksAmount"] = "0x" + blob.hex()
    return jsonify({"ciphertext": out})


@app.post("/match")
def match_orders():
    body = request.get_json(silent=True) or {}
    o1, o2 = body.get("order1"), body.get("order2")
    if not o1 or not o2:
        return jsonify({"error": "Missing order data"}), 400
    assets_match = (
        o1.get("inputAssetID") == o2.get("outputAssetID")
        and o1.get("outputAssetID") == o2.get("inputAssetID")
    )
    if not assets_match:
        return jsonify(
            {
                "matched": False,
                "fheEncryptedResult": "0x",
                "executionId": "0x" + ("00" * 32),
            }
        )
    a1 = str(o1.get("fheEncryptedInputAmount", ""))
    a2 = str(o2.get("fheEncryptedInputAmount", ""))
    ts_part = _now_ms()
    inner = keccak256(str(a1).encode("utf-8")) + keccak256(str(a2).encode("utf-8")) + ts_part.encode("utf-8")
    execution_id = "0x" + keccak256(inner).hex()
    msg = f"CKKS_MATCH:{execution_id}".encode("utf-8")
    fhe_result = "0x" + msg.hex()
    return jsonify({"matched": True, "fheEncryptedResult": fhe_result, "executionId": execution_id})


@app.post("/compute")
def compute():
    body = request.get_json(silent=True) or {}
    op = body.get("operation")
    enc_in = body.get("encryptedInputs")
    if not op or enc_in is None:
        return jsonify({"error": "Missing operation or inputs"}), 400
    sec = get_secret_context()
    if op == "add" and isinstance(enc_in, list) and len(enc_in) == 2:
        try:
            b1 = bytes.fromhex(str(enc_in[0]).replace("0x", ""))
            b2 = bytes.fromhex(str(enc_in[1]).replace("0x", ""))
            v1 = ts.ckks_vector_from(sec, b1)
            v2 = ts.ckks_vector_from(sec, b2)
            out = v1 + v2
            out_hex = "0x" + out.serialize().hex()
            eid = keccak256_hex_utf8(out_hex + _now_ms())
            return jsonify(
                {
                    "operation": op,
                    "fheEncryptedResult": out_hex,
                    "executionId": eid,
                    "library": "tenseal",
                }
            )
        except Exception as e:
            return jsonify({"error": str(e)}), 400
    rnd = keccak256(str(time.time()).encode("utf-8")).hex()
    return jsonify(
        {
            "operation": op,
            "fheEncryptedResult": "0x" + rnd,
            "executionId": keccak256_hex_utf8(op + rnd),
            "library": "tenseal",
        }
    )


@app.post("/compatibility")
def compatibility():
    body = request.get_json(silent=True) or {}
    taker = body.get("taker") or {}
    candidate = body.get("candidate") or {}
    if not taker or not candidate:
        return jsonify({"compatible": False, "code": "invalid_payload", "attestationRef": None}), 200
    sides_opposite = str(taker.get("side", "")) != str(candidate.get("side", ""))
    pair_match = (
        str(taker.get("pairBase", "")) == str(candidate.get("pairBase", ""))
        and str(taker.get("pairQuote", "")) == str(candidate.get("pairQuote", ""))
    )
    compatible = bool(sides_opposite and pair_match)
    return jsonify(
        {
            "compatible": compatible,
            "code": "ok" if compatible else "reject_pair_or_side",
            "attestationRef": f"tenseal-demo:{_now_ms()}",
        }
    )


@app.get("/attestation-pubkey")
def attestation_pubkey():
    acct = get_service_signer()
    return jsonify(
        {
            "signerAddress": acct.address,
            "scheme": "ECDSA secp256k1",
            "library": "tenseal",
            "fheScheme": "CKKS",
        }
    )


def _intent_required(intent: dict, side_label: str):
    missing = [k for k in ("user", "side", "inputAssetID", "outputAssetID", "amount", "limitPrice") if k not in intent]
    if missing:
        return f"{side_label}_intent_missing_fields:{','.join(missing)}"
    return None


def _ciphertext_amount(bundle: dict, intent: dict) -> float:
    blob = bundle.get("_ckksAmount") if isinstance(bundle, dict) else None
    if isinstance(blob, str) and blob.startswith("0x"):
        return he_decrypt_first(blob)
    fallback = intent.get("amount")
    return float(fallback) if fallback is not None else 0.0


def _ciphertext_price(bundle: dict, intent: dict) -> float:
    blob = bundle.get("_ckksPrice") if isinstance(bundle, dict) else None
    if isinstance(blob, str) and blob.startswith("0x"):
        return he_decrypt_first(blob)
    fallback = intent.get("limitPrice")
    return float(fallback) if fallback is not None else 0.0


@app.post("/internal-match/compare")
def internal_match_compare():
    body = request.get_json(silent=True) or {}
    maker = body.get("maker") or {}
    taker = body.get("taker") or {}
    maker_intent = maker.get("intent") or {}
    taker_intent = taker.get("intent") or {}

    err = _intent_required(maker_intent, "maker") or _intent_required(taker_intent, "taker")
    if err:
        return jsonify({"matched": False, "reason": err}), 400

    maker_side = int(maker_intent.get("side", -1))
    taker_side = int(taker_intent.get("side", -1))
    if maker_side not in (0, 1) or taker_side not in (0, 1) or maker_side == taker_side:
        return jsonify({"matched": False, "reason": "side_mismatch"}), 200

    if str(maker_intent.get("inputAssetID")) != str(taker_intent.get("outputAssetID")) or str(
        maker_intent.get("outputAssetID")
    ) != str(taker_intent.get("inputAssetID")):
        return jsonify({"matched": False, "reason": "asset_mismatch"}), 200

    now = int(time.time())
    for label, intent in (("maker", maker_intent), ("taker", taker_intent)):
        deadline = intent.get("deadline")
        if deadline is not None and int(deadline) <= now:
            return jsonify({"matched": False, "reason": f"{label}_expired"}), 200

    try:
        maker_amount = _ciphertext_amount(maker.get("ciphertext"), maker_intent)
        taker_amount = _ciphertext_amount(taker.get("ciphertext"), taker_intent)
        maker_price = _ciphertext_price(maker.get("ciphertext"), maker_intent)
        taker_price = _ciphertext_price(taker.get("ciphertext"), taker_intent)
    except Exception as e:
        return jsonify({"matched": False, "reason": f"fhe_decrypt_failed:{str(e)[:120]}"}), 400

    sell_price, buy_price = (maker_price, taker_price) if maker_side == 0 else (taker_price, maker_price)
    if buy_price < sell_price:
        return jsonify({"matched": False, "reason": "price_cross_failed"}), 200

    exec_amount = min(max(0.0, maker_amount), max(0.0, taker_amount))
    if exec_amount <= 0:
        return jsonify({"matched": False, "reason": "amount_zero"}), 200

    exec_price = (sell_price + buy_price) / 2.0
    ts_ms = _now_ms()
    canonical = {
        "v": "phantom-fhe-attestation/v1",
        "matched": True,
        "makerCiphertextHash": str(maker_intent.get("ciphertextHash") or ""),
        "takerCiphertextHash": str(taker_intent.get("ciphertextHash") or ""),
        "makerUser": str(maker_intent.get("user") or ""),
        "takerUser": str(taker_intent.get("user") or ""),
        "makerNonce": str(maker_intent.get("nonce", "0")),
        "takerNonce": str(taker_intent.get("nonce", "0")),
        "inputAssetID": str(taker_intent.get("inputAssetID")),
        "outputAssetID": str(taker_intent.get("outputAssetID")),
        "execAmount": safe_int_str(exec_amount),
        "execPrice": safe_int_str(exec_price),
        "ts": ts_ms,
    }
    digest_hex = "0x" + keccak256(stable_stringify(canonical).encode("utf-8")).hex()
    signature_hex = sign_decision_digest(digest_hex)
    signer = get_service_signer().address

    return jsonify(
        {
            "matched": True,
            "reason": None,
            "result": {
                "execPrice": canonical["execPrice"],
                "execAmount": canonical["execAmount"],
                "ts": ts_ms,
            },
            "bindings": {
                "makerCiphertextHash": canonical["makerCiphertextHash"],
                "takerCiphertextHash": canonical["takerCiphertextHash"],
                "makerUser": canonical["makerUser"],
                "takerUser": canonical["takerUser"],
            },
            "attestation": {
                "decisionHash": digest_hex,
                "signature": signature_hex,
                "signerAddress": signer,
                "canonical": canonical,
            },
        }
    )


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "9101"))
    app.run(host="0.0.0.0", port=port, threaded=True)
