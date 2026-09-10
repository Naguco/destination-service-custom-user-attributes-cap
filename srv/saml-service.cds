type SamlInspectResult {
  raw      : String;
  decoded  : String;
  tokenType: String;
  error    : String;
}

@path: '/api'
service SamlInspectorService @(requires: 'authenticated-user') {
  action inspectSamlViaExchange(destinationName: String)     returns SamlInspectResult;
}
