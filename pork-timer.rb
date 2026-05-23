cask "pork-timer" do
  version "0.1.0"
  sha256 :no_check

  url "https://github.com/saintpbh/meetingtimmer/releases/download/v#{version}/PORK%20Timer_#{version}_aarch64.dmg"
  name "PORK Timer"
  desc "Futuristic premium presentation countdown timer"
  homepage "https://github.com/saintpbh/meetingtimmer"

  app "PORK Timer.app"

  zap trash: [
    "~/Library/Application Support/com.bongpark.porktimer",
    "~/Library/Preferences/com.bongpark.porktimer.plist",
    "~/Library/Saved Application State/com.bongpark.porktimer.savedState",
  ]
end
