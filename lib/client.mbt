///|
/// Minimal client for the TypeSafe AI Jev API
/// (http://docs.typesafe.ai, OpenAPI at /openapi.json on the API host).
pub struct Client {
  api_key : String
  base_url : String
}

///|
pub fn Client::new(api_key : String) -> Client {
  { api_key, base_url: "https://api.typesafe.ai", }
}

///|
pub fn Client::with_base_url(api_key : String, base_url : String) -> Client {
  { api_key, base_url, }
}

///|
fn auth_headers(api_key : String) -> Map[@http.CaseInsensitiveString, String] {
  { "authorization": "Bearer \{api_key}", "content-type": "application/json" }
}

///|
/// GET /v1/models — the model names/aliases available to this account.
pub async fn Client::list_models(self : Client) -> Array[Model] {
  let (resp, body) = @http.get(
    "\{self.base_url}/v1/models",
    headers=auth_headers(self.api_key),
  )
  let text = body.text()
  if resp.code != 200 {
    raise ApiError::Http(resp.code, resp.reason, text)
  }
  let json = @json.parse(text) catch {
    _ =>
      raise ApiError::InvalidResponse(
        "models: response is not JSON: \{clamp_text(text)}",
      )
  }
  let m = json_object(json, "models response")
  match m.get("models") {
    Some(Json::Array(items)) => items.map(v => Model::from_json(v))
    Some(other) =>
      raise ApiError::InvalidResponse(
        "models: expected array, got \{other.stringify()}",
      )
    None => raise ApiError::InvalidResponse("models: missing")
  }
}

///|
/// How many times to attempt a request before giving up, and the base backoff.
/// Transient failures (HTTP 429/5xx and network errors) are retried with
/// exponential backoff; everything else is returned/raised immediately. This
/// mirrors the retry the TS client already had — without it, a burst of Jev
/// calls (e.g. two MOBA players hammering the API every tick) trips a rate
/// limit and every caller falls back to holding, as docs/10 §5 flagged.
const MAX_ATTEMPTS = 5

///|
const BACKOFF_BASE_MS = 250

///|
fn backoff_ms(attempt : Int) -> Int {
  // 250, 500, 1000, 2000, … capped at 8s.
  let ms = BACKOFF_BASE_MS * (1 << attempt)
  if ms > 8000 {
    8000
  } else {
    ms
  }
}

///|
/// True for status codes worth retrying: rate limit and server errors.
fn retryable_code(code : Int) -> Bool {
  code == 429 || code == 408 || code >= 500
}

///|
/// POST /v1/systemone — evaluate all named questions against `state` in a
/// single parallel call. Answers are keyed by question name. Transient
/// failures are retried with backoff.
pub async fn Client::system_one(
  self : Client,
  req : SystemOneRequest,
) -> SystemOneResponse {
  req.validate()
  let payload = req.to_json()
  let mut last_status = 0
  let mut last_body = ""
  for attempt in 0..<MAX_ATTEMPTS {
    // A network-level failure raises; treat it like a retryable status.
    let outcome = try {
      let (resp, body) = @http.post(
        "\{self.base_url}/v1/systemone",
        payload,
        headers=auth_headers(self.api_key),
      )
      Some((resp.code, resp.reason, body.text()))
    } catch {
      _ => None
    }
    match outcome {
      Some((200, _, text)) => {
        let json = @json.parse(text) catch {
          _ =>
            raise ApiError::InvalidResponse(
              "systemone: response is not JSON: \{clamp_text(text)}",
            )
        }
        return SystemOneResponse::from_json(json)
      }
      Some((code, reason, text)) => {
        last_status = code
        last_body = text
        if retryable_code(code) && attempt < MAX_ATTEMPTS - 1 {
          @async.Timer(backoff_ms(attempt)).wait()
          continue
        }
        raise ApiError::Http(code, reason, text)
      }
      None => {
        last_status = -1
        if attempt < MAX_ATTEMPTS - 1 {
          @async.Timer(backoff_ms(attempt)).wait()
          continue
        }
        raise ApiError::InvalidResponse(
          "systemone: network error after \{MAX_ATTEMPTS} attempts",
        )
      }
    }
  }
  // The loop always returns or raises; this satisfies the type-checker.
  raise ApiError::Http(last_status, "retries exhausted", clamp_text(last_body))
}

///|
fn clamp_text(s : String) -> String {
  let limit = 400
  if s.length() <= limit {
    s
  } else {
    s[:limit].to_owned() + "…"
  }
}
