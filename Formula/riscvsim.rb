# Homebrew formula for the StudyRISC-V CLI.
#
# Lives in this repo as the source of truth; publish by copying into the
# tap repo `rawcache/homebrew-riscvsim` (Homebrew requires the `homebrew-`
# prefix on tap repo names). Users then run:
#
#   brew tap rawcache/riscvsim
#   brew install riscvsim
#
# The stable URLs point at the SAME GitHub release tarballs install.sh uses
# — one source of truth for release artifacts. The sha256 values are for the v0.2.0
# release assets; update url/sha256 together on each release.
# `brew install --HEAD riscvsim` builds from source (requires Rust).
class Riscvsim < Formula
  desc "RISC-V (RV32IM/RV64IM) 5-stage pipeline simulator for the terminal and browser"
  homepage "https://studyriscv.com"
  version "0.2.0"
  license "MIT"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/rawcache/riscvsim/releases/download/v0.2.0/riscvsim-macos-arm64.tar.gz"
      sha256 "08e940ad8389897ea05611e9d369da0d1e873e797d15412cda5c9f001f2d784b"
    else
      url "https://github.com/rawcache/riscvsim/releases/download/v0.2.0/riscvsim-macos-x86_64.tar.gz"
      sha256 "fe966ac07bf55b78c90e7066e1bd2d5b1428600937aa2e3c866952171f359ca7"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "https://github.com/rawcache/riscvsim/releases/download/v0.2.0/riscvsim-linux-arm64.tar.gz"
      sha256 "1ed5ef875d69696f79e78a201c2417a6983241dd1cdb3ec8d252c3f3cd20fffd"
    else
      url "https://github.com/rawcache/riscvsim/releases/download/v0.2.0/riscvsim-linux-x86_64.tar.gz"
      sha256 "c13ea3e74594baadc4980ada8a09e1345f3942617413405b5d4a36fc2ef51314"
    end
  end

  head "https://github.com/rawcache/riscvsim.git", branch: "main"

  depends_on "rust" => :build if build.head?

  def install
    if build.head?
      cd "cli" do
        system "cargo", "install", *std_cargo_args
      end
    else
      bin.install "riscvsim"
    end
  end

  def caveats
    <<~'EOS'
      Run `riscvsim` to start the interactive simulator.
      Run `riscvsim doctor` to inspect the active executable, PATH copies,
      published version, and Homebrew upgrade instructions.
    EOS
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/riscvsim --version")

    # run a real program through the pipeline and check for a clean finish
    (testpath/"add.s").write <<~ASM
      addi x1, x0, 5
      addi x2, x1, 3
      add  x3, x2, x1
    ASM
    output = shell_output("#{bin}/riscvsim run #{testpath}/add.s")
    assert_match "program complete", output
    assert_match(/x3:\s+0 -> 13/, output)
  end
end
