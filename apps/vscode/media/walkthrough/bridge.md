## Prepare the API bridge

Run [Set Up Bridge](command:crepair.setUpBridge) once and wait for the ready
message. C Repair prepares a private Python environment using bundled wheels.
If `uv` is missing, it offers to install it or explains manual installation.
The bridge listens on 127.0.0.1 only.

Local model setup includes this preparation automatically. This separate step
is for API inference.

To retry or inspect setup errors, see the [Quick start & user guide](command:crepair.openUserGuide).
