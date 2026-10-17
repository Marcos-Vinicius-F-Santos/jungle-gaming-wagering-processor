import {
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
  registerDecorator,
  ValidationOptions,
} from 'class-validator';

import { isIso4217Currency } from '../../../../shared/domain/money';

@ValidatorConstraint({ name: 'isIso4217Currency', async: false })
export class IsIso4217CurrencyConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return typeof value === 'string' && isIso4217Currency(value);
  }

  defaultMessage(args: ValidationArguments): string {
    return `${args.property} must be a valid ISO-4217 currency code`;
  }
}

export function IsIso4217Currency(validationOptions?: ValidationOptions): PropertyDecorator {
  return (object: object, propertyName: string | symbol) => {
    registerDecorator({
      name: 'isIso4217Currency',
      target: object.constructor,
      propertyName: propertyName.toString(),
      options: validationOptions,
      validator: IsIso4217CurrencyConstraint,
    });
  };
}
