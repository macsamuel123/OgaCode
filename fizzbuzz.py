def fizzbuzz(n: int) -> str:
    """Return the FizzBuzz string for a given number n."""
    if n % 3 == 0 and n % 5 == 0:
        return "FizzBuzz"
    if n % 3 == 0:
        return "Fizz"
    if n % 5 == 0:
        return "Buzz"
    return str(n)


def main():
    for i in range(1, 101):
        print(fizzbuzz(i))


if __name__ == "__main__":
    main()
