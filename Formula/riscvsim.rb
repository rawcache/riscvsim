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
# — one source of truth for release artifacts. Before publishing, replace
# each PLACEHOLDER_SHA256 with `shasum -a 256 <asset>` of the real release
# asset; `brew audit` fails until then. Until a release exists,
# `brew install --HEAD riscvsim` builds from source (requires Rust).
class Riscvsim < Formula
  desc "RISC-V (RV32IM) 5-stage pipeline simulator for the terminal and browser"
  homepage "https://studyriscv.com"
  version "0.1.0"
  license "MIT"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/rawcache/riscvsim/releases/download/v0.1.0/riscvsim-macos-arm64.tar.gz"
      sha256 "PLACEHOLDER_SHA256_MACOS_ARM64"
    else
      url "https://github.com/rawcache/riscvsim/releases/download/v0.1.0/riscvsim-macos-x86_64.tar.gz"
      sha256 "PLACEHOLDER_SHA256_MACOS_X86_64"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "https://github.com/rawcache/riscvsim/releases/download/v0.1.0/riscvsim-linux-arm64.tar.gz"
      sha256 "PLACEHOLDER_SHA256_LINUX_ARM64"
    else
      url "https://github.com/rawcache/riscvsim/releases/download/v0.1.0/riscvsim-linux-x86_64.tar.gz"
      sha256 "PLACEHOLDER_SHA256_LINUX_X86_64"
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
    assert_match "x3: 0 -> 13", output
  end
end
