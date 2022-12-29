// Signal K application template file.
//
// This application demonstrates core SensESP concepts in a very
// concise manner. You can build and upload the application as is
// and observe the value changes on the serial port monitor.
//
// You can use this source file as a basis for your own projects.
// Remove the parts that are not relevant to you, and add your own code
// for external hardware libraries.

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
                    // Set a custom hostname for the app.
                    ->set_hostname("boat-remote")
                    // Optionally, hard-code the WiFi and Signal K server
                    // settings. This is normally not needed.
                    //->set_wifi("My WiFi SSID", "my_wifi_password")
                    //->set_sk_server("192.168.10.3", 80)
                    ->get_app();



  // Read GPIO 14 every time it changes
  // Board G14

  // Create another digital input, this time with RepeatSensor. This approach
  // can be used to connect external sensor library to SensESP!

  const uint8_t kDigitalInputAPin = 14;
  const unsigned int kDigitalInputAInterval = 1000;

  // Configure the pin. Replace this with your custom library initialization
  // code!
  pinMode(kDigitalInputAPin, INPUT_PULLDOWN);

  // Define a new RepeatSensor that reads the pin every 100 ms.
  // Replace the lambda function internals with the input routine of your custom
  // library.

  // Again, test this yourself by connecting pin 15 to pin 13 with a jumper
  // wire and see if the value changes!

  auto* digital_inputA = new RepeatSensor<bool>(
      kDigitalInputAInterval,
      [kDigitalInputAPin]() { return digitalRead(kDigitalInputAPin); });

  // Connect digital input 2 to Signal K output.
  digital_inputA->connect_to(new SKOutputBool(
      "sensors.digital_inputA.value",          // Signal K path
      "/sensors/digital_inputA/value",         // configuration path
      new SKMetadata("",                       // No units for boolean values
                     "Digital input A value")  // Value description
      ));




  // Read GPIO 25 every time it changes
  // Board G25

  // Create another digital input, this time with RepeatSensor. This approach
  // can be used to connect external sensor library to SensESP!

  const uint8_t kDigitalInputBPin = 25;
  const unsigned int kDigitalInputBInterval = 1000;

  // Configure the pin. Replace this with your custom library initialization
  // code!
  pinMode(kDigitalInputBPin, INPUT_PULLDOWN);

  // Define a new RepeatSensor that reads the pin every 100 ms.
  // Replace the lambda function internals with the input routine of your custom
  // library.

  // Again, test this yourself by connecting pin 15 to pin 13 with a jumper
  // wire and see if the value changes!

  auto* digital_inputB = new RepeatSensor<bool>(
      kDigitalInputBInterval,
      [kDigitalInputBPin]() { return digitalRead(kDigitalInputBPin); });

  // Connect digital input 2 to Signal K output.
  digital_inputB->connect_to(new SKOutputBool(
      "sensors.digital_inputB.value",          // Signal K path
      "/sensors/digital_inputB/value",         // configuration path
      new SKMetadata("",                       // No units for boolean values
                     "Digital input B value")  // Value description
      ));    

  // Start networking, SK server connections and other SensESP internals
  sensesp_app->start();
}

void loop() { app.tick(); }
