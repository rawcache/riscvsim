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
# — one source of truth for release artifacts. The sha256 values are for the v0.1.0
# release assets; update url/sha256 together on each release.
# `brew install --HEAD riscvsim` builds from source (requires Rust).
class Riscvsim < Formula
  desc "RISC-V (RV32IM) 5-stage pipeline simulator for the terminal and browser"
  homepage "https://studyriscv.com"
  version "0.1.0"
  license "MIT"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/rawcache/riscvsim/releases/download/v0.1.0/riscvsim-macos-arm64.tar.gz"
      sha256 "ac0898f5250ed00f1f00beb1ff833e3b689f7ed103742f06f2d4f1b19c0ddef3"
    else
      url "https://github.com/rawcache/riscvsim/releases/download/v0.1.0/riscvsim-macos-x86_64.tar.gz"
      sha256 "d2ab2a6a043421c241bf2a50abb6c49465fcb4317347fbf0f73814fbd8f7404a"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "https://github.com/rawcache/riscvsim/releases/download/v0.1.0/riscvsim-linux-arm64.tar.gz"
      sha256 "c38ecf6d37f1d4a5849e2653e211ebc7644acd8e83d152d639dd7ab46f863a45"
    else
      url "https://github.com/rawcache/riscvsim/releases/download/v0.1.0/riscvsim-linux-x86_64.tar.gz"
      sha256 "e680f4ff68df3afc547bede013611f3573193222efb523c5de35c48eb82a9a6e"
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
