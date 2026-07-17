/* Echoes the raw POST body back as text/plain so the test can verify what
 * actually went over the wire after VentoNetworkObserver's substitution. */
function handleRequest(request, response) {
  let body = "";
  if (request.method == "POST") {
    const stream = Cc["@mozilla.org/scriptableinputstream;1"].createInstance(
      Ci.nsIScriptableInputStream
    );
    stream.init(request.bodyInputStream);
    let chunk;
    while ((chunk = stream.read(4096))) {
      body += chunk;
    }
  }
  response.setStatusLine(request.httpVersion, 200, "OK");
  response.setHeader("Content-Type", "text/plain; charset=utf-8", false);
  response.write("BODY:" + body);
}
