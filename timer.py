#!/usr/bin/env python3
"""Countdown timer with a rich progress bar.

Usage:
    python timer.py 10          # count down from 10 seconds
    python timer.py 60          # count down from 1 minute
    python timer.py 120 --label "Cooking"  # with custom label
"""

import argparse
import time

from rich.console import Console
from rich.progress import (
    BarColumn,
    Progress,
    TextColumn,
    TimeElapsedColumn,
    TimeRemainingColumn,
)


def countdown(seconds: int, label: str = "Countdown") -> None:
    """Count down from N seconds with a rich progress bar."""
    console = Console()

    progress = Progress(
        TextColumn(f"[bold cyan]{label}[/]"),
        BarColumn(bar_width=None),
        "[progress.percentage]{task.percentage:>3.0f}%",
        TimeRemainingColumn(),
        TimeElapsedColumn(),
        console=console,
    )

    with progress:
        task = progress.add_task("", total=seconds)

        for _ in range(seconds):
            time.sleep(1)
            progress.advance(task)

    console.print("[bold green]Done![/]")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Count down from N seconds with a rich progress bar."
    )
    parser.add_argument(
        "seconds",
        type=int,
        help="Number of seconds to count down from",
    )
    parser.add_argument(
        "--label",
        type=str,
        default="Countdown",
        help="Label shown on the progress bar (default: Countdown)",
    )
    args = parser.parse_args()

    if args.seconds <= 0:
        parser.error("seconds must be a positive integer")

    countdown(args.seconds, label=args.label)


if __name__ == "__main__":
    main()
