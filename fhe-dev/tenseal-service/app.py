import os
import time
from Crypto.Hash import keccak
import tenseal as ts
from flask import Flask, jsonify, request

app = Flask(__name__)


def _now_ms():
    return str(int(time.time() * 1000))

_secret_ctx = None


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


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "9101"))
    app.run(host="0.0.0.0", port=port, threaded=True)
