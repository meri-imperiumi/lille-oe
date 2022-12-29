#include "sensesp/sensors/digital_input.h"
#include "sensesp/sensors/sensor.h"
#include "sensesp/signalk/signalk_output.h"
#include "sensesp/system/lambda_consumer.h"
#include "sensesp_app_builder.h"

using namespace sensesp;

reactesp::ReactESP app;

// The setup function performs one-time application initialization.
void setup() {
#ifndef SERIAL_DEBUG_DISABLED
  SetupSerialDebug(115200);
#endif

  // Construct the global SensESPApp() object
  SensESPAppBuilder builder;
  sensesp_app = (&builder)
                    ->set_hostname("boat-remote")
                    ->get_app();



  // Read GPIO 14 every time it changes
  // Board G14

  const uint8_t kDigitalInputAPin = 14;
  const unsigned int kDigitalInputAInterval = 1000;
  pinMode(kDigitalInputAPin, INPUT_PULLDOWN);

  auto* digital_inputA = new RepeatSensor<bool>(
      kDigitalInputAInterval,
      [kDigitalInputAPin]() { return digitalRead(kDigitalInputAPin); });

  // Connect digital input A to Signal K output.
  digital_inputA->connect_to(new SKOutputBool(
      "electrical.switches.remoteA.state",              // Signal K path
      "/electrical/switches_remoteA/state",             // configuration path
      new SKMetadata("",                                // No units for boolean values
                     "Electical switch remote A state") // Value description
      ));




  // Read GPIO 25 every time it changes
  // Board G25

  const uint8_t kDigitalInputBPin = 25;
  const unsigned int kDigitalInputBInterval = 1000;
  pinMode(kDigitalInputBPin, INPUT_PULLDOWN);

  auto* digital_inputB = new RepeatSensor<bool>(
      kDigitalInputBInterval,
      [kDigitalInputBPin]() { return digitalRead(kDigitalInputBPin); });

  // Connect digital input 2 to Signal K output.
  digital_inputB->connect_to(new SKOutputBool(
      "electrical.switches.remoteB.state",              // Signal K path
      "/electrical/switches_remoteB/state",             // configuration path
      new SKMetadata("",                                // No units for boolean values
                     "Electical switch remote B state") // Value description
      ));    

  // Start networking, SK server connections and other SensESP internals
  sensesp_app->start();
}

void loop() { app.tick(); }
