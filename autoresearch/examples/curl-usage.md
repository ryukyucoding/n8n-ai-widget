# Local broker example

Run the broker in one terminal:

```powershell
node autoresearch/broker/server.js
```

Then create a task from a second terminal:

```powershell
$request = Get-Content autoresearch/examples/create-execution-task.json -Raw
Invoke-RestMethod -Uri http://127.0.0.1:8787/rpc -Method Post -ContentType 'application/json' -Body $request
```

Copy the returned `result.id` into a new `SendMessage` request when reporting a
result. Do not copy a task state file between machines: the broker is the source of
truth. For a multi-machine broker, configure a private network endpoint and a token
outside this repository as described in `ARCHITECTURE.md`.
